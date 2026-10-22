from concurrent.futures import ThreadPoolExecutor
import secrets
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import URL
from backend.app import _postgresql_url, create_app

TEST_ADMIN_KEY=secrets.token_urlsafe(32)
AUTH={'Authorization':f'Bearer {TEST_ADMIN_KEY}'}
TEST_DATABASE_URL=URL.create(
    'postgresql',
    username='test-user',
    password=secrets.token_urlsafe(32),
    host='db.example.invalid',
    database='test_db',
).render_as_string(hide_password=False)


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path/'test.db',TEST_ADMIN_KEY)) as c:
        yield c


def payload(client,quantity=1,pid=1):
    product=next(p for p in client.get('/api/products').json() if p['id']==pid)
    return {'customer':'Test Customer','email':'test@example.test','address':'123 Demo Street','items':[{'product_id':pid,'quantity':quantity,'unit_price':product['price']}]}


def buy(client,data=None,key=None):
    return client.post('/api/orders',json=data or payload(client),headers={'Idempotency-Key':key or str(uuid.uuid4())})


def test_catalog_and_search(client):
    assert client.get('/api/health').json()['status']=='ok'
    assert len(client.get('/api/products').json())==12
    assert len(client.get('/api/products?q=coffee').json())==1
    assert all(p['category']=='Dairy' for p in client.get('/api/products?category=Dairy').json())


def test_admin_requires_auth(client):
    for path in ['/products','/orders','/report']:
        assert client.get('/api/admin'+path).status_code==401
        assert client.get('/api/admin'+path,headers=AUTH).status_code==200


def test_product_crud_archive_and_restore(client):
    p=client.get('/api/products').json()[0];p.pop('id');p['name']='New test product'
    added=client.post('/api/admin/products',json=p,headers=AUTH)
    assert added.status_code==201
    pid=added.json()['id'];p['stock']=2;p['price']=125
    assert client.put(f'/api/admin/products/{pid}',json=p,headers=AUTH).json()['price']==125
    assert client.delete(f'/api/admin/products/{pid}',headers=AUTH).status_code==200
    assert pid not in [p['id'] for p in client.get('/api/products').json()]
    p['active']=True
    assert client.put(f'/api/admin/products/{pid}',json=p,headers=AUTH).json()['active'] is True


def test_checkout_deducts_stock_and_protects_receipt(client):
    before=client.get('/api/products').json()[0]['stock'];r=buy(client,payload(client,2))
    assert r.status_code==201;o=r.json();assert o['total']==36000
    assert client.get('/api/products').json()[0]['stock']==before-2
    assert client.get('/api/orders/'+o['id']).status_code==404
    receipt=client.get('/api/orders/'+o['id'],headers={'X-Order-Token':o['token']})
    assert receipt.status_code==200 and 'token' not in receipt.json()


def test_idempotency_and_conflict(client):
    key=str(uuid.uuid4());data=payload(client);one=buy(client,data,key);two=buy(client,data,key)
    assert one.json()['id']==two.json()['id']
    data['customer']='Changed customer'
    assert buy(client,data,key).status_code==409


def test_insufficient_stock_is_atomic(client):
    data=payload(client);before=client.get('/api/products').json()[0]['stock']
    data['items'].append({'product_id':11,'quantity':1,'unit_price':4000})
    assert buy(client,data).status_code==409
    assert client.get('/api/products').json()[0]['stock']==before


def test_duplicate_lines_cannot_oversell(client):
    data=payload(client,20);data['items']*=2
    assert buy(client,data).status_code==409


def test_changed_price_is_rejected(client):
    data=payload(client);data['items'][0]['unit_price']=1
    assert buy(client,data).status_code==409


def test_invalid_checkout(client):
    for value in [0,-1,1.5,100]:
        data=payload(client);data['items'][0]['quantity']=value
        assert buy(client,data).status_code==422
    data=payload(client);data['email']='invalid'
    assert buy(client,data).status_code==422


def test_cancellation_restores_once(client):
    before=client.get('/api/products').json()[0]['stock'];o=buy(client).json()
    for _ in range(2):
        assert client.patch('/api/admin/orders/'+o['id'],json={'status':'cancelled'},headers=AUTH).status_code==200
    assert client.get('/api/products').json()[0]['stock']==before
    assert client.patch('/api/admin/orders/'+o['id'],json={'status':'packed'},headers=AUTH).status_code==409


def test_completion_reporting_and_history(client):
    baseline=client.get('/api/admin/report',headers=AUTH).json()['revenue'];o=buy(client).json();path='/api/admin/orders/'+o['id']
    assert client.patch(path,json={'status':'completed'},headers=AUTH).status_code==409
    for status in ['packed','completed']:
        assert client.patch(path,json={'status':status},headers=AUTH).status_code==200
    assert client.get('/api/admin/report',headers=AUTH).json()['revenue']==baseline+o['total']
    client.delete('/api/admin/products/1',headers=AUTH)
    assert client.get('/api/orders/'+o['id'],headers={'X-Order-Token':o['token']}).json()['items'][0]['name']=='Orchard apples'
    assert client.get('/api/admin/report?start=2099-01-01',headers=AUTH).json()['revenue']==0
    assert client.get('/api/admin/report?start=2026-02-01&end=2026-01-01',headers=AUTH).status_code==422


def test_low_stock_and_invalid_inventory(client):
    r=client.get('/api/admin/report',headers=AUTH).json();assert len(r['low_stock'])==3
    p=client.get('/api/products').json()[0];pid=p.pop('id');p['stock']=-1
    assert client.put(f'/api/admin/products/{pid}',json=p,headers=AUTH).status_code==422


def test_concurrent_checkouts_serialize_stock(client):
    p=client.get('/api/products').json()[0];pid=p.pop('id');p['stock']=1
    client.put(f'/api/admin/products/{pid}',json=p,headers=AUTH)
    data=payload(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        codes=list(pool.map(lambda _:buy(client,data).status_code,range(2)))
    assert sorted(codes)==[201,409]
    assert client.get('/api/products').json()[0]['stock']==0


def test_database_survives_restart(tmp_path):
    path=tmp_path/'persistent.db'
    with TestClient(create_app(path,TEST_ADMIN_KEY)) as c:
        o=buy(c).json();stock=c.get('/api/products').json()[0]['stock']
    with TestClient(create_app(path,TEST_ADMIN_KEY)) as c:
        assert c.get('/api/products').json()[0]['stock']==stock
        assert c.get('/api/orders/'+o['id'],headers={'X-Order-Token':o['token']}).status_code==200
        assert len(c.get('/api/products').json())==12


def test_database_path_uses_environment_and_creates_parent(monkeypatch, tmp_path):
    path=tmp_path/'nested'/'store.db'
    monkeypatch.setenv('DATABASE_PATH',str(path))
    with TestClient(create_app(admin_key=TEST_ADMIN_KEY)) as c:
        assert c.get('/api/health').json()['status']=='ok'
        assert len(c.get('/api/products').json())==12
    assert path.is_file()


@pytest.mark.parametrize('key',['admindash','short','x'*31])
def test_production_rejects_weak_admin_keys(monkeypatch, tmp_path, key):
    monkeypatch.setenv('APP_ENV', 'production')
    monkeypatch.setenv('DATABASE_URL', TEST_DATABASE_URL)
    with pytest.raises(RuntimeError):
        create_app(tmp_path/'production.db', key)


def test_production_accepts_long_admin_key(monkeypatch, tmp_path):
    monkeypatch.setenv('APP_ENV', 'production')
    monkeypatch.setenv('DATABASE_URL', TEST_DATABASE_URL)
    create_app(tmp_path/'production.db', secrets.token_urlsafe(32))


def test_production_requires_database_url(monkeypatch, tmp_path):
    monkeypatch.setenv('APP_ENV', 'production')
    monkeypatch.delenv('DATABASE_URL', raising=False)
    with pytest.raises(RuntimeError, match='Production requires DATABASE_URL'):
        create_app(tmp_path/'production.db',TEST_ADMIN_KEY)


def test_postgresql_url_uses_psycopg_and_preserves_ssl_parameters():
    dummy_password = secrets.token_urlsafe(32)
    source = URL.create(
        'postgresql',
        username='test-user',
        password=dummy_password,
        host='db.example.test',
        database='test_db',
        query={'sslmode': 'require', 'channel_binding': 'require'},
    )
    url = _postgresql_url(source.render_as_string(hide_password=False))
    assert url.drivername == 'postgresql+psycopg'
    assert url.query == {'sslmode': 'require', 'channel_binding': 'require'}
    assert url.password == dummy_password


def test_explicit_cors_origin(monkeypatch, tmp_path):
    monkeypatch.setenv('CORS_ORIGINS', 'https://demo.netlify.app')
    with TestClient(create_app(tmp_path/'cors.db',TEST_ADMIN_KEY)) as c:
        headers={'Origin':'https://demo.netlify.app','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,idempotency-key'}
        response=c.options('/api/orders',headers=headers)
        assert response.status_code==200
        assert response.headers['access-control-allow-origin']=='https://demo.netlify.app'
        headers['Origin']='https://unlisted.example'
        assert c.options('/api/orders',headers=headers).status_code==400
