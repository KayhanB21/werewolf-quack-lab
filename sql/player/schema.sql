-- Reference schema for one player node.
-- The running lab renders this shape from bin/player-node.sh so each container
-- can seed its own role/token from environment variables.

CREATE TABLE self (
  agent_id VARCHAR PRIMARY KEY,
  role VARCHAR NOT NULL,
  partners VARCHAR[]
);

CREATE TABLE game_flags (
  post_game BOOLEAN NOT NULL
);

CREATE TABLE knowledge (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  content VARCHAR NOT NULL,
  confidence DOUBLE NOT NULL DEFAULT 0.5,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE suspicions (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  target_agent VARCHAR NOT NULL,
  p_wolf DOUBLE NOT NULL,
  reasoning VARCHAR NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE intents (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  action VARCHAR NOT NULL,
  target VARCHAR,
  rationale VARCHAR,
  public_text VARCHAR,
  decided_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE votes (
  round INTEGER NOT NULL,
  voter VARCHAR NOT NULL,
  target VARCHAR NOT NULL,
  decided_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE VIEW public_intents AS
SELECT round, agent_id, action, target, public_text, decided_at
FROM intents
WHERE public_text IS NOT NULL;

CREATE VIEW wolf_channel AS
SELECT round, agent_id, action, target, rationale, decided_at
FROM intents
WHERE action = 'wolf-kill'
  AND (SELECT role FROM self LIMIT 1) = 'wolf';

CREATE VIEW post_game_intents AS
SELECT round, agent_id, action, target, public_text, rationale, decided_at
FROM intents
WHERE (SELECT post_game FROM game_flags LIMIT 1);
