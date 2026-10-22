from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone, date
from pathlib import Path
from typing import Literal
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import uuid

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

BASE = Path(__file__).resolve().parent
CATEGORIES = ('Produce', 'Dairy', 'Bakery', 'Pantry')
ICONS = ('apple', 'banana', 'tomato', 'milk', 'jar', 'bread', 'bag', 'egg', 'leaf')


class Product(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    category: Literal['Produce', 'Dairy', 'Bakery', 'Pantry']
    description: str = Field(min_length=1, max_length=500)
    unit: str = Field(min_length=1, max_length=40)
    price: int = Field(gt=0, le=100000000, strict=True)
    stock: int = Field(ge=0, le=100000, strict=True)
    low_stock: int = Field(ge=0, le=100000, strict=True)
    icon: Literal['apple', 'banana', 'tomato', 'milk', 'jar', 'bread', 'bag', 'egg', 'leaf'] = 'bag'
    active: bool = True


class Line(BaseModel):
    model_config = ConfigDict(extra='forbid')
    product_id: int = Field(gt=0, strict=True)
    quantity: int = Field(gt=0, le=99, strict=True)
    unit_price: int = Field(gt=0, strict=True)


class Checkout(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    customer: str = Field(min_length=2, max_length=80)
    email: str = Field(min_length=5, max_length=160)
    address: str = Field(min_length=8, max_length=300)
    items: list[Line] = Field(min_length=1, max_length=100)

    @field_validator('email')
    @classmethod
    def email_shape(cls, value):
        if value.count('@') != 1 or '.' not in value.split('@')[1] or any(c.isspace() for c in value):
            raise ValueError('Enter a valid email address')
        return value


class StatusUpdate(BaseModel):
    status: Literal['packed', 'completed', 'cancelled']


SCHEMA = '''
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
 description TEXT NOT NULL, unit TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0),
 stock INTEGER NOT NULL CHECK(stock>=0), low_stock INTEGER NOT NULL,
 icon TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, token TEXT NOT NULL, customer TEXT NOT NULL, email TEXT NOT NULL,
 address TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL,
 created TEXT NOT NULL, idempotency TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
 product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL,
 unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
'''


def create_app(db_path=None, admin_key=None, seed=True):
    database = str(db_path or os.getenv('DATABASE_PATH', str(BASE / 'data' / 'smartmart.db')))
    key = admin_key or os.getenv('ADMIN_KEY', 'admindash')
    if os.getenv('APP_ENV') == 'production' and (key == 'admindash' or len(key) < 32):
        raise RuntimeError('Production requires a unique ADMIN_KEY of at least 32 characters.')

    @contextmanager
    def db(write=False):
        conn = sqlite3.connect(database, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            if write:
                conn.execute('BEGIN IMMEDIATE')
            yield conn
            if write:
                conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @asynccontextmanager
    async def lifespan(app):
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        with db() as c:
            c.execute('PRAGMA journal_mode=WAL')
            c.executescript(SCHEMA)
        with db(True) as c:
            if seed and not c.execute("SELECT 1 FROM metadata WHERE key='seeded'").fetchone():
                for item in json.loads((BASE / 'seed.json').read_text(encoding='utf-8')):
                    c.execute('INSERT INTO products(name,category,description,unit,price,stock,low_stock,icon) VALUES(:name,:category,:description,:unit,:price,:stock,:low_stock,:icon)', item)
                oid = str(uuid.uuid4())
                c.execute('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?)', (oid,secrets.token_urlsafe(32),'Demo customer','demo@example.test','Demo address — not a real delivery',24800,'completed',datetime.now(timezone.utc).isoformat(),'seed-order','seed'))
                for pid in (1,4):
                    p=c.execute('SELECT * FROM products WHERE id=?',(pid,)).fetchone()
                    c.execute('INSERT INTO order_items(order_id,product_id,name,unit_price,quantity) VALUES(?,?,?,?,1)',(oid,pid,p['name'],p['price']))
                    c.execute('UPDATE products SET stock=stock-1 WHERE id=?',(pid,))
                c.execute("INSERT INTO metadata VALUES('seeded','1')")
        yield

    app=FastAPI(title='SmartMart API',version='1.0.0',lifespan=lifespan)
    origins=[o.strip() for o in os.getenv('CORS_ORIGINS','http://localhost:8000,http://127.0.0.1:8000').split(',') if o.strip()]
    app.add_middleware(CORSMiddleware,allow_origins=origins,allow_methods=['GET','POST','PUT','PATCH','DELETE'],allow_headers=['Content-Type','Authorization','Idempotency-Key','X-Order-Token'])

    def admin(authorization: str = Header(default='')):
        if not hmac.compare_digest(authorization.encode(),f'Bearer {key}'.encode()):
            raise HTTPException(401,'Admin access key required')

    def product_dict(row):
        d=dict(row);d['active']=bool(d['active']);return d

    def order_dict(c,row,include_token=False):
        d=dict(row)
        for field in ('idempotency','request_hash'):
            d.pop(field,None)
        if not include_token:
            d.pop('token',None)
        d['items']=[dict(r) for r in c.execute('SELECT product_id,name,unit_price,quantity FROM order_items WHERE order_id=?',(d['id'],))]
        return d

    @app.get('/api/health')
    def health():
        with db() as c:
            c.execute('SELECT 1').fetchone()
        return {'status':'ok','checkout':'simulated'}

    @app.get('/api/products')
    def products(q: str = Query(default='',max_length=100),category: str = ''):
        with db() as c:
            return [product_dict(r) for r in c.execute('SELECT * FROM products WHERE active=1 AND (name LIKE ? OR description LIKE ?) AND (?="" OR category=?) ORDER BY id',(f'%{q}%',f'%{q}%',category,category))]

    @app.get('/api/admin/products',dependencies=[Depends(admin)])
    def inventory():
        with db() as c:
            return [product_dict(r) for r in c.execute('SELECT * FROM products ORDER BY active DESC,id')]

    @app.post('/api/admin/products',status_code=201,dependencies=[Depends(admin)])
    def add_product(product: Product):
        d=product.model_dump()
        with db(True) as c:
            cursor=c.execute('INSERT INTO products(name,category,description,unit,price,stock,low_stock,icon,active) VALUES(:name,:category,:description,:unit,:price,:stock,:low_stock,:icon,:active)',d)
            return product_dict(c.execute('SELECT * FROM products WHERE id=?',(cursor.lastrowid,)).fetchone())

    @app.put('/api/admin/products/{pid}',dependencies=[Depends(admin)])
    def update_product(pid:int,product:Product):
        with db(True) as c:
            if not c.execute('SELECT 1 FROM products WHERE id=?',(pid,)).fetchone():
                raise HTTPException(404,'Product not found')
            c.execute('UPDATE products SET name=:name,category=:category,description=:description,unit=:unit,price=:price,stock=:stock,low_stock=:low_stock,icon=:icon,active=:active WHERE id=:id',{**product.model_dump(),'id':pid})
            return product_dict(c.execute('SELECT * FROM products WHERE id=?',(pid,)).fetchone())

    @app.delete('/api/admin/products/{pid}',dependencies=[Depends(admin)])
    def delete_product(pid:int):
        with db(True) as c:
            if c.execute('UPDATE products SET active=0 WHERE id=?',(pid,)).rowcount==0:
                raise HTTPException(404,'Product not found')
        return {'archived':pid}

    @app.post('/api/orders',status_code=201)
    def checkout(body:Checkout,idempotency_key:str=Header(min_length=16,max_length=100)):
        fingerprint=hashlib.sha256(body.model_dump_json().encode()).hexdigest()
        with db(True) as c:
            existing=c.execute('SELECT * FROM orders WHERE idempotency=?',(idempotency_key,)).fetchone()
            if existing:
                if existing['request_hash']!=fingerprint:
                    raise HTTPException(409,'This checkout key was already used for a different basket.')
                return order_dict(c,existing,True)
            quantities={};prices={}
            for line in body.items:
                if line.product_id in prices and prices[line.product_id]!=line.unit_price:
                    raise HTTPException(409,'Conflicting prices in basket. Refresh your basket.')
                quantities[line.product_id]=quantities.get(line.product_id,0)+line.quantity
                prices[line.product_id]=line.unit_price
            total=0;lines=[]
            for pid,quantity in quantities.items():
                p=c.execute('SELECT * FROM products WHERE id=? AND active=1',(pid,)).fetchone()
                if not p:
                    raise HTTPException(409,'A product is no longer available. Refresh your basket.')
                if quantity>99 or p['stock']<quantity:
                    raise HTTPException(409,f"Not enough stock for {p['name']}. Refresh your basket.")
                if prices[pid]!=p['price']:
                    raise HTTPException(409,f"The price of {p['name']} changed. Review your basket again.")
                total+=p['price']*quantity
                lines.append((p,quantity))
            oid=str(uuid.uuid4());token=secrets.token_urlsafe(32)
            c.execute('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?)',(oid,token,body.customer,body.email,body.address,total,'pending',datetime.now(timezone.utc).isoformat(),idempotency_key,fingerprint))
            for p,quantity in lines:
                c.execute('UPDATE products SET stock=stock-? WHERE id=?',(quantity,p['id']))
                c.execute('INSERT INTO order_items(order_id,product_id,name,unit_price,quantity) VALUES(?,?,?,?,?)',(oid,p['id'],p['name'],p['price'],quantity))
            return order_dict(c,c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone(),True)

    @app.get('/api/orders/{oid}')
    def get_order(oid:str,x_order_token:str=Header(default='')):
        with db() as c:
            order=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
            if not order or not hmac.compare_digest(order['token'].encode(),x_order_token.encode()):
                raise HTTPException(404,'Order not found')
            return order_dict(c,order)

    @app.get('/api/admin/orders',dependencies=[Depends(admin)])
    def orders():
        with db() as c:
            return [order_dict(c,r) for r in c.execute('SELECT * FROM orders ORDER BY created DESC')]

    @app.patch('/api/admin/orders/{oid}',dependencies=[Depends(admin)])
    def update_order(oid:str,body:StatusUpdate):
        allowed={'pending':{'packed','cancelled'},'packed':{'completed','cancelled'},'completed':set(),'cancelled':set()}
        with db(True) as c:
            row=c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
            if not row:
                raise HTTPException(404,'Order not found')
            if row['status']==body.status:
                return order_dict(c,row)
            if body.status not in allowed[row['status']]:
                raise HTTPException(409,'Invalid order status transition')
            if body.status=='cancelled':
                for line in c.execute('SELECT product_id,quantity FROM order_items WHERE order_id=?',(oid,)).fetchall():
                    c.execute('UPDATE products SET stock=stock+? WHERE id=?',(line['quantity'],line['product_id']))
            c.execute('UPDATE orders SET status=? WHERE id=?',(body.status,oid))
            return order_dict(c,c.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone())

    @app.get('/api/admin/report',dependencies=[Depends(admin)])
    def report(start:date|None=None,end:date|None=None):
        if start and end and start>end:
            raise HTTPException(422,'Start date must be before end date')
        lo=start.isoformat() if start else '0000';hi=end.isoformat() if end else '9999'
        with db() as c:
            selected=[dict(r) for r in c.execute('SELECT * FROM orders WHERE substr(created,1,10)>=? AND substr(created,1,10)<=?',(lo,hi))]
            complete=[r for r in selected if r['status']=='completed']
            days={}
            for r in complete:
                day=r['created'][:10];days[day]=days.get(day,0)+r['total']
            top=[dict(r) for r in c.execute('SELECT i.name,SUM(i.quantity) AS quantity,SUM(i.quantity*i.unit_price) AS revenue FROM order_items i JOIN orders o ON i.order_id=o.id WHERE o.status="completed" AND substr(o.created,1,10)>=? AND substr(o.created,1,10)<=? GROUP BY i.product_id,i.name ORDER BY revenue DESC LIMIT 5',(lo,hi))]
            low=[product_dict(r) for r in c.execute('SELECT * FROM products WHERE active=1 AND stock<=low_stock ORDER BY stock')]
            return {'revenue':sum(r['total'] for r in complete),'completed':len(complete),'orders':len(selected),'pending':sum(r['status'] in ('pending','packed') for r in selected),'cancelled':sum(r['status']=='cancelled' for r in selected),'daily':[{'date':k,'revenue':v} for k,v in sorted(days.items())],'top_products':top,'low_stock':low}

    app.mount('/',StaticFiles(directory=str(BASE.parent/'frontend'),html=True),name='frontend')
    return app


app=create_app()
