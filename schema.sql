-- Eén rij houdt de volledige toestand vast: recepten, planning, vinkjes, instellingen.
CREATE TABLE IF NOT EXISTS state (
  id      TEXT PRIMARY KEY,
  rev     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  updated TEXT
);

-- Verbruiksteller voor de Claude-suggesties (dag- en minuutvensters).
-- De Worker maakt deze tabel ook zelf aan als ze ontbreekt.
CREATE TABLE IF NOT EXISTS usage (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
