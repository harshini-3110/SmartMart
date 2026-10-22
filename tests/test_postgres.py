from concurrent.futures import ThreadPoolExecutor
import os
import re
import secrets
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from backend.app import create_app


POSTGRES_TEST_URL = os.getenv('SMARTMART_TEST_DATABASE_URL')
ADMIN_KEY = secrets.token_urlsafe(32)
AUTH = {'Authorization': f'Bearer {ADMIN_KEY}'}

pytestmark = pytest.mark.skipif(
    not POSTGRES_TEST_URL,
    reason='Set SMARTMART_TEST_DATABASE_URL to a disposable PostgreSQL test database.',
)


@pytest.fixture
def postgres_database(monkeypatch):
    url = make_url(POSTGRES_TEST_URL)
    if url.drivername not in ('postgresql', 'postgresql+psycopg'):
        pytest.fail('SMARTMART_TEST_DATABASE_URL must use postgresql://.')
    if not url.database or not re.search(r'(test|disposable)', url.database, re.I):
        pytest.fail('PostgreSQL integration tests require a database name containing test or disposable.')
    url = url.set(drivername='postgresql+psycopg')
    admin_engine = create_engine(url, pool_pre_ping=True)
    schema = 'smartmart_test_' + uuid.uuid4().hex
    quoted_schema = admin_engine.dialect.identifier_preparer.quote_schema(schema)
    with admin_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA {quoted_schema}'))
    scoped_url = url.update_query_dict({'options': f'-csearch_path={schema}'})
    monkeypatch.setenv('APP_ENV', 'production')
    yield scoped_url
    with admin_engine.begin() as connection:
        connection.execute(text(f'DROP SCHEMA {quoted_schema} CASCADE'))
    admin_engine.dispose()


@pytest.fixture
def client(postgres_database):
    app = create_app(
        database_url=postgres_database.render_as_string(hide_password=False),
        admin_key=ADMIN_KEY,
    )
    with TestClient(app) as test_client:
        yield test_client


def stock_product(client, stock):
    product = next(p for p in client.get('/api/admin/products', headers=AUTH).json() if p['id'] == 1)
    product_id = product['id']
    update = {
        field: product[field]
        for field in ('name', 'category', 'description', 'unit', 'price', 'stock', 'low_stock', 'icon', 'active')
    }
    update['stock'] = stock
    response = client.put(f"/api/admin/products/{product_id}", json=update, headers=AUTH)
    assert response.status_code == 200, response.text
    return response.json()


def order_payload(product, quantity=1):
    return {
        'customer': 'Postgres Test',
        'email': 'postgres@example.test',
        'address': '123 Disposable Test Street',
        'items': [{
            'product_id': product['id'],
            'quantity': quantity,
            'unit_price': product['price'],
        }],
    }


def checkout(client, payload, key=None):
    return client.post(
        '/api/orders',
        json=payload,
        headers={'Idempotency-Key': key or str(uuid.uuid4())},
    )


def test_postgres_concurrent_checkout_prevents_overselling(client):
    product = stock_product(client, 1)
    payload = order_payload(product)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: checkout(client, payload), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert next(p for p in client.get('/api/admin/products', headers=AUTH).json() if p['id'] == 1)['stock'] == 0


def test_postgres_concurrent_idempotency_charges_once(client):
    product = stock_product(client, 3)
    payload = order_payload(product)
    key = str(uuid.uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: checkout(client, payload, key), range(2)))
    assert [response.status_code for response in responses] == [201, 201]
    assert responses[0].json()['id'] == responses[1].json()['id']
    assert next(p for p in client.get('/api/admin/products', headers=AUTH).json() if p['id'] == 1)['stock'] == 2


def test_postgres_concurrent_cancellation_restores_stock_once(client):
    product = stock_product(client, 3)
    order = checkout(client, order_payload(product)).json()
    path = f"/api/admin/orders/{order['id']}"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(
            lambda _: client.patch(path, json={'status': 'cancelled'}, headers=AUTH),
            range(2),
        ))
    assert [response.status_code for response in responses] == [200, 200]
    assert next(p for p in client.get('/api/admin/products', headers=AUTH).json() if p['id'] == 1)['stock'] == 3


def test_postgres_reporting_and_restart_persistence(postgres_database):
    restarted_app = create_app(
        database_url=postgres_database.render_as_string(hide_password=False),
        admin_key=ADMIN_KEY,
    )
    with TestClient(restarted_app) as first:
        product = stock_product(first, 3)
        order = checkout(first, order_payload(product)).json()
        order_path = f"/api/admin/orders/{order['id']}"
        assert first.patch(order_path, json={'status': 'packed'}, headers=AUTH).status_code == 200
        assert first.patch(order_path, json={'status': 'completed'}, headers=AUTH).status_code == 200
        report = first.get('/api/admin/report', headers=AUTH).json()
        assert report['completed'] >= 2
        assert any(row['revenue'] >= order['total'] for row in report['daily'])
        remaining_stock = next(
            p for p in first.get('/api/admin/products', headers=AUTH).json() if p['id'] == 1
        )['stock']
        order_id = order['id']
        receipt_token = order['token']
    restarted_app = create_app(
        database_url=postgres_database.render_as_string(hide_password=False),
        admin_key=ADMIN_KEY,
    )
    with TestClient(restarted_app) as restarted:
        assert restarted.get('/api/health').json()['status'] == 'ok'
        assert next(
            p for p in restarted.get('/api/admin/products', headers=AUTH).json() if p['id'] == 1
        )['stock'] == remaining_stock
        assert restarted.get(
            f'/api/orders/{order_id}',
            headers={'X-Order-Token': receipt_token},
        ).status_code == 200
        assert len(restarted.get('/api/products').json()) == 12
