-- Eén rij houdt de volledige toestand vast: recepten, planning, vinkjes, instellingen.
CREATE TABLE IF NOT EXISTS state (
  id      TEXT PRIMARY KEY,
  rev     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  updated TEXT
);
