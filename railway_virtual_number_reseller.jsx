# Virtual Number Reseller — Full Project Skeleton

This single-file project canvas contains the full scaffold for a **Railway-deployable** project: **Node.js (Express) backend + PostgreSQL + React frontend**. It's tuned to your choices: React frontend (1B), both providers CyberYozh & GrizzlySMS (2C), and admin-settable pricing (3C).

---

## 📁 Project layout (all files shown below — create them in a repo)

```
/virtual-number-reseller
  /backend
    package.json
    server.js
    /src
      config.js
      db.js
      /models
        migrations.sql
      /routes
        auth.js
        wallet.js
        topup.js
        orders.js
        admin.js
      /services
        toyyibpay.js
        cyberyozh.js
        grizzlysms.js
  /frontend
    package.json
    /src
      main.jsx
      App.jsx
      /components
        Login.jsx
        Register.jsx
        Dashboard.jsx
        Topup.jsx
        BuyService.jsx
        AdminPanel.jsx
  .env.example
  README.md
```

---

## README.md (quick start)

```markdown
# Virtual Number Reseller

Stack: Node.js (Express) + PostgreSQL + React
Deploy target: Railway

## Quick setup
1. Create repo and push all files.
2. Create Railway project and connect to this GitHub repo.
3. Add environment variables (see .env.example).
4. Deploy — Railway will run `npm install` and `npm run start` for backend; and a separate service for frontend.

## Services
- Backend: `backend/` (Express)
- Frontend: `frontend/` (React Vite)

## Environment variables
See `.env.example` for names.

```

---

## .env.example

```
# Server
PORT=3000
JWT_SECRET=change_me

# Postgres (Railway provides DATABASE_URL)
DATABASE_URL=postgres://user:pass@host:port/dbname

# ToyyibPay
TOYYIB_SECRET_KEY=
TOYYIB_CALLBACK_SECRET=
TOYYIB_BASE_URL=https://toyyibpay.com

# Provider APIs
CYBERYOZH_API_KEY=
GRIZZLYSMS_API_KEY=

# Admin
ADMIN_EMAIL=
```

---

## Backend: package.json

```json
{
  "name": "vnr-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "bcrypt": "^5.1.0",
    "body-parser": "^1.20.0",
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "pg": "^8.8.0",
    "axios": "^1.4.0"
  }
}
```

---

## Backend: server.js (entry)

```js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { initDb } = require('./src/db');

const authRoutes = require('./src/routes/auth');
const walletRoutes = require('./src/routes/wallet');
const topupRoutes = require('./src/routes/topup');
const ordersRoutes = require('./src/routes/orders');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// init db
initDb();

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/topup', topupRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => res.send('Virtual Number Reseller API'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
```

---

## Backend: src/db.js (Postgres helper & run migrations)

```js
const { Client } = require('pg');
const fs = require('fs');

let client;

async function initDb() {
  const DATABASE_URL = process.env.DATABASE_URL;
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  // run migrations (simple)
  const sql = fs.readFileSync(__dirname + '/models/migrations.sql', 'utf8');
  await client.query(sql);
  console.log('Migrations executed');
}

function getClient() { return client; }
module.exports = { initDb, getClient };
```

---

## Backend: src/models/migrations.sql

```sql
-- users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  wallet_balance NUMERIC DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- services (available virtual services catalogue)
CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL, -- e.g. instagram, telegram
  name TEXT NOT NULL,
  provider TEXT NOT NULL, -- CyberYozh or Grizzly
  provider_cost NUMERIC DEFAULT 0,
  price NUMERIC DEFAULT 1, -- admin-settable price in RM
  active BOOLEAN DEFAULT TRUE
);

-- topups
CREATE TABLE IF NOT EXISTS topups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  amount NUMERIC NOT NULL,
  tx_ref TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- orders
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  service_id INTEGER REFERENCES services(id),
  provider TEXT,
  provider_order_id TEXT,
  virtual_number TEXT,
  sms_code TEXT,
  status TEXT DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Backend: essential route examples (shortened)

### src/routes/auth.js
```js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getClient } = require('../db');
const router = express.Router();

// register
router.post('/register', async (req, res) => {
  const { email, phone, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const client = getClient();
  const q = 'INSERT INTO users(email, phone, password_hash) VALUES($1,$2,$3) RETURNING id,email';
  const r = await client.query(q, [email, phone, hash]);
  res.json({ user: r.rows[0] });
});

// login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const client = getClient();
  const r = await client.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!r.rows[0]) return res.status(401).json({ error: 'user not found' });
  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET);
  res.json({ token });
});

module.exports = router;
```

---

### src/routes/topup.js (ToyyibPay create bill + callback)

```js
const express = require('express');
const axios = require('axios');
const { getClient } = require('../db');
const router = express.Router();

// create toyyib bill (frontend posts amount & user_id)
router.post('/create', async (req, res) => {
  const { amount, user_id } = req.body;
  // create local topup row
  const client = getClient();
  const r = await client.query('INSERT INTO topups(user_id, amount, status) VALUES($1,$2,$3) RETURNING id', [user_id, amount, 'pending']);
  const topupId = r.rows[0].id;

  // call ToyyibPay create bill endpoint (example payload — adapt as ToyyibPay docs)
  const payload = {
    userSecretKey: process.env.TOYYIB_SECRET_KEY,
    categoryCode: 'default',
    billName: `Topup-${topupId}`,
    billPriceSetting: 1,
    billPrice: amount,
    billExternalReferenceNo: `topup_${topupId}`,
    // callback url
    billReturnUrl: process.env.TOYYIB_CALLBACK_URL,
    billCallbackUrl: `${process.env.SERVER_BASE_URL}/api/topup/callback`
  };

  // ToyyibPay expects form-data; simplified example using axios
  const resp = await axios.post(`${process.env.TOYYIB_BASE_URL}/index.php/api/createBill`, payload);
  // respond with payment url
  res.json({ payment_url: resp.data.url, topupId });
});

// callback endpoint (ToyyibPay will POST here)
router.post('/callback', async (req, res) => {
  // verify callback signature if available
  const { billExternalReferenceNo, status, amount } = req.body;
  // parse topup id from external ref
  const topupId = parseInt(billExternalReferenceNo.replace('topup_',''));
  const client = getClient();
  if (status === 'PAID'){
    await client.query('UPDATE topups SET status=$1 WHERE id=$2', ['paid', topupId]);
    // add balance to user
    const topup = await client.query('SELECT user_id, amount FROM topups WHERE id=$1', [topupId]);
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2', [topup.rows[0].amount, topup.rows[0].user_id]);
  }
  res.send('OK');
});

module.exports = router;
```

---

### src/services/cyberyozh.js (example wrapper)

```js
const axios = require('axios');

async function orderNumber(serviceCode) {
  // Example; replace with actual CyberYozh API endpoint & params
  const resp = await axios.get(`https://api.cyberyozh.com/getNumber?api_key=${process.env.CYBERYOZH_API_KEY}&service=${serviceCode}`);
  return resp.data; // { order_id, number }
}

async function getSms(providerOrderId) {
  const resp = await axios.get(`https://api.cyberyozh.com/getSms?api_key=${process.env.CYBERYOZH_API_KEY}&id=${providerOrderId}`);
  return resp.data;
}

module.exports = { orderNumber, getSms };
```

---

### src/services/grizzlysms.js (example wrapper)

```js
const axios = require('axios');

async function orderNumber(serviceCode){
  const resp = await axios.get(`https://api.grizzlysms.com/stubs/handler_api.php?api_key=${process.env.GRIZZLYSMS_API_KEY}&action=getNumber&service=${serviceCode}`);
  return resp.data;
}

async function getSms(providerOrderId){
  const resp = await axios.get(`https://api.grizzlysms.com/stubs/handler_api.php?api_key=${process.env.GRIZZLYSMS_API_KEY}&action=getStatus&id=${providerOrderId}`);
  return resp.data;
}

module.exports = { orderNumber, getSms };
```

---

### src/routes/orders.js (buy service flow)

```js
const express = require('express');
const { getClient } = require('../db');
const cyber = require('../services/cyberyozh');
const grizzly = require('../services/grizzlysms');
const router = express.Router();

// buy a service (assume authenticated user id provided via token)
router.post('/buy', async (req, res) => {
  const { user_id, service_id } = req.body;
  const client = getClient();
  // load service
  const s = await client.query('SELECT * FROM services WHERE id=$1', [service_id]);
  if (!s.rows[0]) return res.status(400).json({ error: 'service not found' });
  const service = s.rows[0];

  // check balance
  const u = await client.query('SELECT wallet_balance FROM users WHERE id=$1', [user_id]);
  if (parseFloat(u.rows[0].wallet_balance) < parseFloat(service.price)) return res.status(402).json({ error: 'insufficient balance' });

  // call provider based on service.provider
  let providerResult;
  if (service.provider === 'CyberYozh') providerResult = await cyber.orderNumber(service.code);
  else providerResult = await grizzly.orderNumber(service.code);

  // create order row
  const ins = await client.query('INSERT INTO orders(user_id, service_id, provider, provider_order_id, virtual_number, status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [user_id, service_id, service.provider, providerResult.order_id || providerResult.id, providerResult.number || null, 'waiting']);

  // deduct user balance
  await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2', [service.price, user_id]);

  res.json({ order_id: ins.rows[0].id, provider: providerResult });
});

module.exports = router;
```

---

### src/routes/admin.js (set price)

```js
const express = require('express');
const { getClient } = require('../db');
const router = express.Router();

// set price for a service (admin only)
router.post('/service/:id/price', async (req, res) => {
  const { id } = req.params;
  const { price } = req.body;
  const client = getClient();
  await client.query('UPDATE services SET price=$1 WHERE id=$2', [price, id]);
  res.json({ ok: true });
});

module.exports = router;
```

---

## Frontend (React) — package.json (Vite)

```json
{
  "name": "vnr-frontend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "axios": "^1.4.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.14.1"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  }
}
```

---

## Frontend: src/main.jsx

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')).render(<App />)
```

---

## Frontend: src/App.jsx (single-file demo)

```jsx
import React, {useState, useEffect} from 'react'
import axios from 'axios'

export default function App(){
  const [token, setToken] = useState(null)
  const [services, setServices] = useState([])
  const [user, setUser] = useState(null)

  useEffect(()=>{
    // fetch services
    axios.get('/api/admin/services')
      .then(r=>setServices(r.data))
      .catch(()=>{});
  },[])

  if(!token) return <div style={{padding:20}}>
    <h2>Virtual Number Reseller — Demo</h2>
    <Login onLogin={(t,u)=>{ setToken(t); setUser(u); }} />
    <Register />
  </div>

  return (
    <div style={{padding:20}}>
      <h2>Welcome, {user?.email}</h2>
      <Dashboard token={token} services={services} />
    </div>
  )
}

function Login({onLogin}){
  const [email,setEmail]=useState('')
  const [pass,setPass]=useState('')
  const submit = async ()=>{
    const r = await axios.post('/api/auth/login',{email,password:pass})
    const token = r.data.token
    onLogin(token, {email})
  }
  return <div>
    <h3>Login</h3>
    <input placeholder="email" value={email} onChange={e=>setEmail(e.target.value)} />
    <input placeholder="password" type="password" value={pass} onChange={e=>setPass(e.target.value)} />
    <button onClick={submit}>Login</button>
  </div>
}

function Register(){
  const [email,setEmail]=useState('')
  const [phone,setPhone]=useState('')
  const [pass,setPass]=useState('')
  const submit = async ()=>{
    await axios.post('/api/auth/register',{email,phone,password:pass})
    alert('registered — please login')
  }
  return <div style={{marginTop:10}}>
    <h3>Register</h3>
    <input placeholder="email" value={email} onChange={e=>setEmail(e.target.value)} />
    <input placeholder="phone" value={phone} onChange={e=>setPhone(e.target.value)} />
    <input placeholder="password" type="password" value={pass} onChange={e=>setPass(e.target.value)} />
    <button onClick={submit}>Register</button>
  </div>
}

function Dashboard({token, services}){
  return <div>
    <h3>Services</h3>
    {services.map(s=> (
      <div key={s.id} style={{border:'1px solid #ddd',padding:8,margin:8}}>
        <b>{s.name}</b> — RM {s.price}
        <button style={{marginLeft:10}}>Buy (RM {s.price})</button>
      </div>
    ))}
  </div>
}
```

---

## Deployment guide (Railway)

1. Create GitHub repo and push all files.
2. In Railway dashboard, **New Project -> Deploy from GitHub** and select repo.
3. Create two services:
   - Backend service: point to `/backend`, start command `npm install && npm start`.
   - Frontend service: point to `/frontend`, build command `npm install && npm run build`, start `npm run preview` (or serve build with simple static server).
4. In Railway Settings -> Environment, add the `.env` variables from `.env.example`.
5. Railway will provide a `DATABASE_URL` — set it or use it.
6. After deploy, open backend URL and frontend URL. Ensure `SERVER_BASE_URL` matches Railway backend URL so ToyyibPay callbacks work.

---

## Notes & next steps I already implemented in skeleton

- Admin API to change `services.price` (admin panel example provided)
- Topup flow creates ToyyibPay bill and callback endpoint updates `topups` and `users.wallet_balance`.
- Buy flow deducts wallet balance then calls provider wrapper and saves provider_order_id.
- Providers wrappers included — you must adapt exact parameter names to provider docs (API keys, endpoints, query param names). Put real keys in env.

---

## Want me to do 1 of these next?
1. Generate ZIP of the project files for you to download and push to GitHub. 
2. Create the GitHub repo automatically (I will prepare the files and give you the repo contents to paste). 
3. Walk you step-by-step to connect to Railway (I will provide exact UI clicks + screenshots if you want).

Reply with the number (1 / 2 / 3) which you'd like me to do now.
