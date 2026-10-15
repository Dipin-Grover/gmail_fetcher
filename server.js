const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = 3000;
const USERS_FILE = './users.json';
const CACHE_TTL_MS = 60000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Map();
const cache = new Map();

function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function createConnection(user) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: user.email,
      password: user.password,
      host: user.host || 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 20000,
      authTimeout: 20000,
      keepalive: {
        interval: 10000,
        idleInterval: 300000,
        forceNoop: true,
      },
    });

    imap.once('ready', () => resolve(imap));

    imap.on('error', (err) => {
      console.error(`IMAP error for ${user.email}:`, err.message);
      pool.delete(user.id);
      reject(err);
    });

    imap.on('end', () => {
      console.log(`IMAP connection ended for ${user.email}`);
      pool.delete(user.id);
    });

    imap.connect();
  });
}

function getConnection(user) {
  return new Promise((resolve, reject) => {
    const existing = pool.get(user.id);

    if (existing && existing.imap && existing.imap.state === 'authenticated') {
      return resolve(existing.imap);
    }

    if (existing && existing.opening) {
      return existing.opening.then(resolve).catch(reject);
    }

    const opening = createConnection(user)
      .then((imap) => {
        pool.set(user.id, { imap, opening: null, box: null });
        return imap;
      })
      .catch((err) => {
        pool.delete(user.id);
        throw err;
      });

    pool.set(user.id, { imap: null, opening, box: null });
    opening.then(resolve).catch(reject);
  });
}

function ensureInboxOpen(user, imap, forceReopen = false) {
  return new Promise((resolve, reject) => {
    const conn = pool.get(user.id);

    if (conn && conn.box && !forceReopen) {
      imap.status('INBOX', (err, boxStatus) => {
        if (!err && boxStatus) {
          conn.box.messages.total = boxStatus.messages.total;
          conn.box.messages.new = boxStatus.messages.new;
        }
        resolve(conn.box);
      });
      return;
    }

    imap.openBox('INBOX', true, (err, box) => {
      if (err) return reject(err);
      if (conn) {
        conn.box = box;

        // Listen for new mail notifications pushed from Gmail in real-time
        if (!conn.listening) {
          conn.listening = true;
          imap.on('mail', async () => {
            console.log(`[${user.email}] Realtime mail event received! Syncing in background...`);
            try {
              const freshEmails = await fetchLastEmails(user, 10, true);
              cache.set(user.id, {
                payload: {
                  user: { id: user.id, name: user.name, email: user.email },
                  count: freshEmails.length,
                  emails: freshEmails,
                },
                at: Date.now(),
              });
              console.log(`[${user.email}] Memory cache updated via background push.`);
            } catch (syncErr) {
              console.error(`[${user.email}] Background mail sync error:`, syncErr.message);
            }
          });
        }
      }
      resolve(box);
    });
  });
}

app.get('/api/users', (req, res) => {
  const users = readUsers();
  res.json(users.map(({ id, name, email }) => ({ id, name, email })));
});

app.post('/api/users', (req, res) => {
  const { name, email, password, host } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, password required' });
  }

  const users = readUsers();

  if (users.find((u) => u.email === email)) {
    return res.status(409).json({ error: 'Email already exists' });
  }

  const newUser = {
    id: 'user' + Date.now(),
    name,
    email,
    password,
    host: host || 'imap.gmail.com',
  };

  users.push(newUser);
  writeUsers(users);

  res.json({ id: newUser.id, name: newUser.name, email: newUser.email });
});

app.delete('/api/users/:id', (req, res) => {
  const users = readUsers();
  const filtered = users.filter((u) => u.id !== req.params.id);

  if (users.length === filtered.length) {
    return res.status(404).json({ error: 'User not found' });
  }

  const conn = pool.get(req.params.id);
  if (conn && conn.imap) {
    try { conn.imap.end(); } catch (e) { }
  }
  pool.delete(req.params.id);
  cache.delete(req.params.id);

  writeUsers(filtered);
  res.json({ success: true });
});

function fetchLastEmails(user, limit = 10, forceRefresh = false) {
  return new Promise(async (resolve, reject) => {
    const t0 = Date.now();
    const mark = (label) => {
      console.log(`[${user.email}] ${label}: ${Date.now() - t0}ms`);
    };

    let imap;
    let box;

    try {
      imap = await getConnection(user);
      mark('connection acquired');
      box = await ensureInboxOpen(user, imap, forceRefresh);
      mark('openBox done');
    } catch (err) {
      return reject(err);
    }

    const total = box.messages.total;
    if (total === 0) return resolve([]);

    const start = Math.max(1, total - limit + 1);
    const end = total;
    const expected = end - start + 1;
    const emails = [];
    let completed = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      emails.sort((a, b) => b.seqno - a.seqno);
      mark('sort done');
      resolve(emails);
    };

    const fetch = imap.seq.fetch(`${start}:${end}`, {
      bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)',
      struct: false,
      markSeen: false,
    });

    fetch.on('message', (msg, seqno) => {
      let raw = '';
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          raw += chunk.toString('utf8');
        });
      });
      msg.once('end', () => {
        const headers = Imap.parseHeader(raw);
        emails.push({
          seqno,
          from: (headers.from && headers.from[0]) || '',
          subject: (headers.subject && headers.subject[0]) || '(No Subject)',
          date: (headers.date && headers.date[0]) || null,
        });
        completed++;
        if (completed === expected) {
          mark('all messages received');
          finish();
        }
      });
    });

    fetch.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function fetchOneBody(user, seqno) {
  return new Promise(async (resolve, reject) => {
    const t0 = Date.now();
    const mark = (label) => {
      console.log(`[${user.email}] body ${seqno} - ${label}: ${Date.now() - t0}ms`);
    };

    let imap;
    try {
      imap = await getConnection(user);
      await ensureInboxOpen(user, imap);
      mark('connection ready');
    } catch (err) {
      return reject(err);
    }

    let raw = '';
    const tFetch = Date.now();

    const fetch = imap.seq.fetch(String(seqno), {
      bodies: '',
      struct: true,
      markSeen: false,
    });

    fetch.on('message', (msg) => {
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          raw += chunk.toString('utf8');
        });
      });
    });

    fetch.once('error', (err) => {
      pool.delete(user.id);
      reject(err);
    });

    fetch.once('end', async () => {
      mark(`body downloaded (${raw.length} bytes)`);

      const tParse = Date.now();
      try {
        const parsed = await simpleParser(raw);
        mark('parsed');
        resolve({
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          subject: parsed.subject || '',
          date: parsed.date || null,
          html: parsed.html || null,
          text: parsed.text || '',
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

app.get('/api/emails/:userId', async (req, res) => {
  const users = readUsers();
  const user = users.find((u) => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const forceRefresh = req.query.refresh === '1';
  const cached = cache.get(user.id);

  // If we have cached/in-memory data, return immediately (<10ms)
  // And if forceRefresh is true, fetch fresh emails asynchronously in the background
  if (cached) {
    if (forceRefresh) {
      // Trigger instant background sync without blocking client response
      fetchLastEmails(user, 10, true)
        .then((freshEmails) => {
          cache.set(user.id, {
            payload: {
              user: { id: user.id, name: user.name, email: user.email },
              count: freshEmails.length,
              emails: freshEmails,
            },
            at: Date.now(),
          });
        })
        .catch((e) => console.error(`Background refresh error for ${user.email}:`, e.message));
    }
    console.log(`[${user.email}] instant memory return (<10ms)`);
    return res.json({ ...cached.payload, cached: true });
  }

  const t0 = Date.now();
  try {
    console.log(`Fetching emails for ${user.email} (initial warm-up)`);
    const emails = await fetchLastEmails(user, 10, false);
    const payload = {
      user: { id: user.id, name: user.name, email: user.email },
      count: emails.length,
      emails,
    };
    cache.set(user.id, { payload, at: Date.now() });
    console.log(`Got ${emails.length} emails in ${Date.now() - t0}ms (warm-up)`);
    res.json(payload);
  } catch (err) {
    console.error(`Failed for ${user.email} after ${Date.now() - t0}ms:`, err.message);
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      count: 0,
      emails: [],
      error: err.message,
    });
  }
});

app.get('/api/email/:userId/:seqno', async (req, res) => {
  const users = readUsers();
  const user = users.find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const seqno = parseInt(req.params.seqno, 10);
  if (!seqno) return res.status(400).json({ error: 'invalid seqno' });

  try {
    const email = await fetchOneBody(user, seqno);
    res.json(email);
  } catch (err) {
    console.warn(`First fetch failed for ${user.email}, retrying with new connection:`, err.message);
    pool.delete(user.id);
    try {
      const email = await fetchOneBody(user, seqno);
      res.json(email);
    } catch (retryErr) {
      console.error(`Body fetch failed for ${user.email}:`, retryErr.message);
      res.status(500).json({ error: retryErr.message });
    }
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});