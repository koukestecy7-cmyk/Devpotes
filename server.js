const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const initSqlJs = require('sql.js')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const crypto = require('crypto')

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.static(__dirname))
app.use(express.json())

const uploadDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)
app.use('/uploads', express.static(uploadDir))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
})
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } })

// ── DATABASE ──

let db

function saveDb() {
  fs.writeFileSync(path.join(__dirname, 'devpotes.db'), Buffer.from(db.export()))
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql)
  if (params.length) stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql)
  if (params.length) stmt.bind(params)
  const row = stmt.step() ? stmt.getAsObject() : null
  stmt.free()
  return row
}

function dbRun(sql, params = []) {
  db.run(sql, params)
  saveDb()
}

async function initDb() {
  const SQL = await initSqlJs()
  const dbPath = path.join(__dirname, 'devpotes.db')
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath))
  } else {
    db = new SQL.Database()
  }

  db.exec(`CREATE TABLE IF NOT EXISTS profils (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE, password TEXT,
    couleur TEXT NOT NULL, comps TEXT DEFAULT '[]',
    msgs INTEGER DEFAULT 0, cree_le TEXT DEFAULT (datetime('now'))
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, auteur TEXT NOT NULL,
    couleur TEXT NOT NULL, texte TEXT NOT NULL,
    salon TEXT NOT NULL DEFAULT 'general',
    heure TEXT DEFAULT (strftime('%H:%M','now','localtime')),
    cree_le TEXT DEFAULT (datetime('now'))
  )`)

  try { db.exec(`ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'`) } catch (e) {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN fichier_nom TEXT`) } catch (e) {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN fichier_url TEXT`) } catch (e) {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN code TEXT`) } catch (e) {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN est_poll INTEGER DEFAULT 0`) } catch (e) {}

  db.exec(`CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL, auteur TEXT NOT NULL,
    emoji TEXT NOT NULL,
    UNIQUE(message_id, auteur, emoji)
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, auteur TEXT NOT NULL,
    question TEXT NOT NULL, options TEXT NOT NULL,
    votes TEXT DEFAULT '{}', salon TEXT NOT NULL,
    cree_le TEXT DEFAULT (datetime('now')), actif INTEGER DEFAULT 1
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT, titre TEXT NOT NULL,
    description TEXT NOT NULL, langage TEXT DEFAULT 'Python',
    niveau TEXT DEFAULT 'Facile', date_jour TEXT UNIQUE,
    cree_le TEXT DEFAULT (datetime('now'))
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS challenge_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id INTEGER NOT NULL,
    auteur TEXT NOT NULL, code TEXT NOT NULL,
    cree_le TEXT DEFAULT (datetime('now'))
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS kanban (
    id INTEGER PRIMARY KEY AUTOINCREMENT, salon TEXT NOT NULL,
    titre TEXT NOT NULL, description TEXT DEFAULT '',
    statut TEXT DEFAULT 'todo', auteur TEXT NOT NULL,
    cree_le TEXT DEFAULT (datetime('now'))
  )`)

  saveDb()

  const nb = dbGet('SELECT COUNT(*) as n FROM messages')
  if (!nb || nb.n === 0) {
    dbRun('INSERT INTO messages (auteur,couleur,texte,salon) VALUES (?,?,?,?)', ['Mariama','#7F77DD','Bienvenue sur DevPotes ! 👋','Projets'])
    dbRun('INSERT INTO messages (auteur,couleur,texte,salon) VALUES (?,?,?,?)', ['Koffi','#D85A30',"Quelqu'un a fait l'exo sur les arbres binaires ?",'Projets'])
    dbRun('INSERT INTO messages (auteur,couleur,texte,salon) VALUES (?,?,?,?)', ['Jean-Luc','#378ADD','Je regarde ça ce soir !','Projets'])
  }

  const nc = dbGet('SELECT COUNT(*) as n FROM challenges')
  if (!nc || nc.n === 0) {
    dbRun('INSERT INTO challenges (titre,description,langage,niveau,date_jour) VALUES (?,?,?,?,?)',
      ['Somme des pairs', 'Écris une fonction qui prend un tableau d\'entiers et retourne la somme des nombres pairs uniquement.', 'Python', 'Facile', new Date().toISOString().split('T')[0]])
  }

  console.log('Base de données SQLite prête — devpotes.db')
}

// ── ROUTES API ──

app.get('/api/messages', (req, res) => {
  const salon = req.query.salon || 'Projets'
  const messages = dbAll('SELECT * FROM messages WHERE salon = ? ORDER BY id ASC LIMIT 50', [salon])
  messages.forEach(m => {
    if (m.est_poll) {
      const poll = dbGet('SELECT * FROM polls WHERE id = ?', [m.id])
      if (poll) { m.poll = poll; m.poll.options = JSON.parse(poll.options); m.poll.votes = JSON.parse(poll.votes || '{}') }
    }
    m.reactions = dbAll('SELECT auteur, emoji FROM reactions WHERE message_id = ?', [m.id])
  })
  res.json(messages)
})

app.post('/api/profil', (req, res) => {
  const { nom, couleur, comps } = req.body
  try {
    dbRun('INSERT OR REPLACE INTO profils (nom,couleur,comps) VALUES (?,?,?)', [nom, couleur, JSON.stringify(comps)])
    const profil = dbGet('SELECT * FROM profils WHERE nom = ?', [nom])
    res.json({ succes: true, profil })
  } catch (err) {
    res.status(400).json({ succes: false, erreur: err.message })
  }
})

app.post('/api/upload', upload.single('fichier'), (req, res) => {
  if (!req.file) return res.status(400).json({ erreur: 'Aucun fichier' })
  const estImage = req.file.mimetype.startsWith('image/')
  res.json({ fichier_nom: req.file.originalname, fichier_url: '/uploads/' + req.file.filename, type: estImage ? 'image' : 'file' })
})

app.put('/api/profil', (req, res) => {
  const { nom, email, couleur, comps, password } = req.body
  const session = dbGet('SELECT * FROM profils WHERE email=?', [email])
  if (!session) return res.status(401).json({ erreur: 'Non authentifié' })
  try {
    if (nom) dbRun('UPDATE profils SET nom=? WHERE email=?', [nom, email])
    if (couleur) dbRun('UPDATE profils SET couleur=? WHERE email=?', [couleur, email])
    if (comps) dbRun('UPDATE profils SET comps=? WHERE email=?', [JSON.stringify(comps), email])
    if (password) {
      const salt = crypto.randomBytes(16).toString('hex')
      const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex')
      dbRun('UPDATE profils SET password=? WHERE email=?', [salt + ':' + hash, email])
    }
    const profil = dbGet('SELECT id,nom,email,couleur,comps,msgs,cree_le FROM profils WHERE email=?', [email])
    profil.comps = JSON.parse(profil.comps || '[]')
    res.json({ succes: true, profil })
  } catch (err) {
    res.status(400).json({ succes: false, erreur: 'Ce pseudo est déjà pris' })
  }
})

app.get('/api/membres', (req, res) => {
  const membres = dbAll('SELECT id,nom,couleur,comps,msgs FROM profils')
  membres.forEach(m => { m.comps = JSON.parse(m.comps || '[]') })
  res.json(membres)
})

// ── AUTH ──

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(pw, salt, 1000, 64, 'sha512').toString('hex')
  return salt + ':' + hash
}

function checkPw(pw, stored) {
  const [salt, hash] = stored.split(':')
  return crypto.pbkdf2Sync(pw, salt, 1000, 64, 'sha512').toString('hex') === hash
}

app.post('/api/register', (req, res) => {
  const { nom, email, password, couleur, comps } = req.body
  if (!nom || !email || !password) return res.status(400).json({ erreur: 'Champs requis' })
  try {
    const hashed = hashPw(password)
    dbRun('INSERT INTO profils (nom,email,password,couleur,comps) VALUES (?,?,?,?,?)',
      [nom, email, hashed, couleur, JSON.stringify(comps || [])])
    const profil = dbGet('SELECT id,nom,email,couleur,comps,msgs,cree_le FROM profils WHERE email=?', [email])
    profil.comps = JSON.parse(profil.comps || '[]')
    res.json({ succes: true, profil })
  } catch (err) {
    res.status(400).json({ succes: false, erreur: err.message.includes('UNIQUE') ? 'Email ou pseudo déjà utilisé' : err.message })
  }
})

app.post('/api/login', (req, res) => {
  const { email, password } = req.body
  const profil = dbGet('SELECT * FROM profils WHERE email=?', [email])
  if (!profil || !checkPw(password, profil.password))
    return res.status(401).json({ succes: false, erreur: 'Email ou mot de passe incorrect' })
  profil.comps = JSON.parse(profil.comps || '[]')
  delete profil.password
  res.json({ succes: true, profil })
})

// ── RÉACTIONS ──

app.post('/api/reactions', (req, res) => {
  const { message_id, auteur, emoji } = req.body
  try {
    const exist = dbGet('SELECT id FROM reactions WHERE message_id=? AND auteur=? AND emoji=?', [message_id, auteur, emoji])
    if (exist) {
      dbRun('DELETE FROM reactions WHERE id=?', [exist.id])
      res.json({ action: 'removed' })
    } else {
      dbRun('INSERT INTO reactions (message_id,auteur,emoji) VALUES (?,?,?)', [message_id, auteur, emoji])
      res.json({ action: 'added' })
    }
  } catch (err) {
    res.status(400).json({ erreur: err.message })
  }
})

app.get('/api/reactions', (req, res) => {
  const reactions = dbAll('SELECT * FROM reactions WHERE message_id = ?', [req.query.message_id])
  res.json(reactions)
})

// ── POLLS ──

app.post('/api/polls', (req, res) => {
  const { auteur, question, options, salon } = req.body
  try {
    const id = Date.now()
    dbRun('INSERT INTO polls (id,auteur,question,options,salon) VALUES (?,?,?,?,?)',
      [id, auteur, question, JSON.stringify(options), salon])
    dbRun('INSERT INTO messages (id,auteur,couleur,texte,salon,type,est_poll) VALUES (?,?,?,?,?,?,?)',
      [id, auteur, '#1D9E75', '📊 ' + question, salon, 'poll', 1])
    io.to(salon).emit('nouveau-poll', { id, auteur, question, options, votes: {} })
    res.json({ succes: true, id })
  } catch (err) {
    res.status(400).json({ erreur: err.message })
  }
})

app.post('/api/polls/vote', (req, res) => {
  const { poll_id, auteur, option_index } = req.body
  const poll = dbGet('SELECT * FROM polls WHERE id=?', [poll_id])
  if (!poll) return res.status(404).json({ erreur: 'Sondage introuvable' })
  const votes = JSON.parse(poll.votes || '{}')
  votes[auteur] = option_index
  dbRun('UPDATE polls SET votes=? WHERE id=?', [JSON.stringify(votes), poll_id])
  io.to(poll.salon).emit('poll-vote', { poll_id, votes })
  res.json({ succes: true })
})

// ── CHALLENGES ──

app.get('/api/challenges/aujourdhui', (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  let challenge = dbGet('SELECT * FROM challenges WHERE date_jour = ?', [today])
  if (!challenge) {
    const defis = [
      { titre: 'Somme des pairs', desc: 'Écris une fonction qui prend un tableau d\'entiers et retourne la somme des nombres pairs uniquement.', lang: 'Python', niveau: 'Facile' },
      { titre: 'Palindrome', desc: 'Vérifie si une chaîne de caractères est un palindrome (se lit identique dans les deux sens).', lang: 'JavaScript', niveau: 'Facile' },
      { titre: 'FizzBuzz', desc: 'Affiche les nombres de 1 à 100. Pour les multiples de 3 affiche Fizz, pour les multiples de 5 affiche Buzz, pour les deux affiche FizzBuzz.', lang: 'Python', niveau: 'Facile' },
      { titre: 'Compter les mots', desc: 'Écris une fonction qui compte le nombre d\'occurrences de chaque mot dans une phrase.', lang: 'JavaScript', niveau: 'Moyen' },
      { titre: 'Tri à bulles', desc: 'Implémente l\'algorithme de tri à bulles pour trier un tableau d\'entiers.', lang: 'Python', niveau: 'Moyen' }
    ]
    const d = defis[Math.floor(Math.random() * defis.length)]
    dbRun('INSERT INTO challenges (titre,description,langage,niveau,date_jour) VALUES (?,?,?,?,?)',
      [d.titre, d.desc, d.lang, d.niveau, today])
    challenge = dbGet('SELECT * FROM challenges WHERE date_jour = ?', [today])
  }
  challenge.submissions = dbAll('SELECT * FROM challenge_submissions WHERE challenge_id=?', [challenge.id])
  res.json(challenge)
})

app.post('/api/challenges/soumettre', (req, res) => {
  const { challenge_id, auteur, code } = req.body
  dbRun('INSERT INTO challenge_submissions (challenge_id,auteur,code) VALUES (?,?,?)', [challenge_id, auteur, code])
  const challenge = dbGet('SELECT * FROM challenges WHERE id=?', [challenge_id])
  io.emit('challenge-soumission', { challenge_id, auteur, total: dbGet('SELECT COUNT(*) as n FROM challenge_submissions WHERE challenge_id=?', [challenge_id]).n })
  res.json({ succes: true })
})

// ── KANBAN ──

app.get('/api/kanban', (req, res) => {
  const items = dbAll('SELECT * FROM kanban WHERE salon=? ORDER BY id DESC', [req.query.salon || 'Projets'])
  res.json(items)
})

app.post('/api/kanban', (req, res) => {
  const { salon, titre, description, auteur } = req.body
  dbRun('INSERT INTO kanban (salon,titre,description,auteur) VALUES (?,?,?,?)', [salon, titre, description, auteur])
  const item = dbAll('SELECT * FROM kanban ORDER BY id DESC LIMIT 1')[0]
  io.to(salon).emit('kanban-update', item)
  res.json(item)
})

app.put('/api/kanban/:id', (req, res) => {
  const { statut } = req.body
  dbRun('UPDATE kanban SET statut=? WHERE id=?', [statut, req.params.id])
  io.to(req.query.salon).emit('kanban-update', { id: parseInt(req.params.id), statut })
  res.json({ succes: true })
})

app.delete('/api/kanban/:id', (req, res) => {
  dbRun('DELETE FROM kanban WHERE id=?', [req.params.id])
  io.to(req.query.salon).emit('kanban-delete', { id: parseInt(req.params.id) })
  res.json({ succes: true })
})

// ── APPELS VIDÉO ──

const callParticipants = {} //  { salon: [{ socketId, name }] }

// ── SOCKET.IO ──

io.on('connection', (socket) => {
  console.log('Nouveau connecté:', socket.id)
  let userSalon = null
  let userName = null

  socket.on('rejoindre-salon', (salon) => {
    socket.join(salon)
    userSalon = salon
    console.log(`📌 ${socket.id} a rejoint: ${salon}`)
  })

  socket.on('message', (data) => {
    if (data.auteur) userName = data.auteur
    dbRun('INSERT INTO messages (auteur,couleur,texte,salon,type,fichier_nom,fichier_url,code) VALUES (?,?,?,?,?,?,?,?)',
      [data.auteur, data.couleur, data.texte, data.salon, data.type || 'text', data.fichier_nom || null, data.fichier_url || null, data.code || null])
    dbRun('UPDATE profils SET msgs = msgs + 1 WHERE nom = ?', [data.auteur])
    data.heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    io.to(data.salon).emit('nouveau-message', data)
    const desc = data.code ? 'Code' : (data.texte || (data.type === 'image' ? 'Image' : 'Fichier'))
    console.log(`💬 [${data.salon}] ${data.auteur}: ${desc}`)
  })

  socket.on('typing', (data) => {
    socket.to(data.salon).emit('typing', { auteur: data.auteur, salon: data.salon })
  })

  socket.on('stop-typing', (data) => {
    socket.to(data.salon).emit('stop-typing', { auteur: data.auteur, salon: data.salon })
  })

  socket.on('reaction', (data) => {
    io.to(data.salon).emit('reaction-update', data)
  })

  // ── SIGNALEMENT APPEL VIDÉO ──

  socket.on('start-call', ({ salon, name }) => {
    userName = name
    userSalon = salon
    if (!callParticipants[salon]) callParticipants[salon] = []
    callParticipants[salon].push({ socketId: socket.id, name })
    socket.to(salon).emit('call-started', { from: socket.id, name })
    console.log(`📹 ${name} a démarré un appel dans ${salon}`)
  })

  socket.on('join-call', ({ salon, name }) => {
    userName = name
    userSalon = salon
    if (!callParticipants[salon]) callParticipants[salon] = []
    callParticipants[salon].push({ socketId: socket.id, name })

    // Envoyer la liste des participants existants au nouveau
    const others = callParticipants[salon].filter(p => p.socketId !== socket.id)
    socket.emit('call-joined', { participants: others })

    // Dire aux autres qu'un nouveau a rejoint
    socket.to(salon).emit('user-joined', { from: socket.id, name })
    console.log(`📹 ${name} a rejoint l'appel dans ${salon}`)
  })

  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal })
  })

  socket.on('end-call', ({ salon }) => {
    if (callParticipants[salon]) {
      callParticipants[salon] = callParticipants[salon].filter(p => p.socketId !== socket.id)
      if (callParticipants[salon].length === 0) delete callParticipants[salon]
    }
    socket.to(salon).emit('call-ended', { from: socket.id })
    console.log(`📹 ${userName || socket.id} a quitté l'appel dans ${salon}`)
  })

  socket.on('disconnect', () => {
    if (userSalon && callParticipants[userSalon]) {
      callParticipants[userSalon] = callParticipants[userSalon].filter(p => p.socketId !== socket.id)
      if (callParticipants[userSalon].length === 0) delete callParticipants[userSalon]
      socket.to(userSalon).emit('call-ended', { from: socket.id })
      console.log(`📹 ${userName || socket.id} déconnecté, appel terminé dans ${userSalon}`)
    }
    console.log('Déconnecté:', socket.id)
  })
})

// ── START ──

const PORT = process.env.PORT || 3000

initDb().then(() => {
  server.listen(PORT, () => {
    console.log('╔═══════════════════════════════════╗')
    console.log('║   DevPotes est lancé !            ║')
    console.log(`║   http://localhost:${PORT}          ║`)
    console.log('╚═══════════════════════════════════╝')
  })
})
