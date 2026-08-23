PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mpn TEXT NOT NULL COLLATE NOCASE UNIQUE,
  manufacturer TEXT,
  description TEXT,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  revision TEXT,
  source_filename TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bom_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  mpn TEXT NOT NULL COLLATE NOCASE,
  qty_per_unit REAL NOT NULL CHECK (qty_per_unit > 0),
  reference TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_bom_items_bom ON bom_items(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_mpn ON bom_items(mpn);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  mpn TEXT NOT NULL COLLATE NOCASE,
  supplier TEXT NOT NULL,
  supplier_sku TEXT,
  available_quantity REAL,
  minimum_order_quantity REAL,
  order_multiple REAL,
  unit_price REAL,
  currency TEXT,
  price_break_quantity REAL,
  lead_time_days REAL,
  lead_time_text TEXT,
  in_stock_now INTEGER,
  product_url TEXT,
  source_tool TEXT,
  raw_json TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_mpn_checked ON offers(mpn, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_supplier_checked ON offers(supplier, checked_at DESC);

CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL,
  query_text TEXT,
  requested_quantity REAL,
  deadline_days REAL,
  status TEXT NOT NULL DEFAULT 'completed',
  result_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_mpn TEXT NOT NULL COLLATE NOCASE,
  candidate_mpn TEXT NOT NULL COLLATE NOCASE,
  replacement_class TEXT NOT NULL,
  electrical_status TEXT,
  package_status TEXT,
  pinout_status TEXT,
  pcb_status TEXT,
  confidence REAL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(original_mpn, candidate_mpn)
);
CREATE INDEX IF NOT EXISTS idx_replacements_original ON replacements(original_mpn);

CREATE TABLE IF NOT EXISTS replacement_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  replacement_id INTEGER NOT NULL REFERENCES replacements(id) ON DELETE CASCADE,
  parameter_name TEXT NOT NULL,
  original_value TEXT,
  candidate_value TEXT,
  requirement TEXT,
  result TEXT,
  source TEXT,
  source_url TEXT,
  source_page TEXT,
  verification_status TEXT NOT NULL,
  notes TEXT
);

-- V2 replacement research is append-only.  The legacy replacements table above
-- remains readable for migration from the earlier data model, but must not be used to overwrite
-- prior evidence from later research runs.
CREATE TABLE IF NOT EXISTS application_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_application_profiles_project ON application_profiles(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS replacement_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_mpn TEXT NOT NULL COLLATE NOCASE,
  application_profile_id INTEGER REFERENCES application_profiles(id) ON DELETE SET NULL,
  application_context_json TEXT NOT NULL DEFAULT '{}',
  hard_constraints_json TEXT NOT NULL DEFAULT '[]',
  soft_preferences_json TEXT NOT NULL DEFAULT '[]',
  search_coverage_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  conclusion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_replacement_runs_original ON replacement_runs(original_mpn, created_at DESC);

CREATE TABLE IF NOT EXISTS replacement_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  replacement_run_id INTEGER NOT NULL REFERENCES replacement_runs(id) ON DELETE CASCADE,
  candidate_mpn TEXT NOT NULL COLLATE NOCASE,
  manufacturer TEXT,
  compatibility_class TEXT NOT NULL,
  electrical_status TEXT NOT NULL,
  package_status TEXT NOT NULL,
  pinout_status TEXT NOT NULL,
  pcb_status TEXT NOT NULL,
  qualification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  second_source_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  evidence_completeness INTEGER NOT NULL CHECK (evidence_completeness BETWEEN 0 AND 100),
  electrical_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  pcb_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  thermal_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  emi_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  supply_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  recommendation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(replacement_run_id, candidate_mpn)
);
CREATE INDEX IF NOT EXISTS idx_replacement_assessments_run ON replacement_assessments(replacement_run_id);

CREATE TABLE IF NOT EXISTS replacement_evidence_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES replacement_assessments(id) ON DELETE CASCADE,
  requirement_code TEXT NOT NULL,
  requirement_name TEXT NOT NULL,
  original_value TEXT,
  candidate_value TEXT,
  result TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  source_locator TEXT,
  source_revision TEXT,
  verification_status TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_replacement_evidence_v2_assessment ON replacement_evidence_v2(assessment_id);

CREATE TABLE IF NOT EXISTS offer_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  mpn TEXT NOT NULL COLLATE NOCASE,
  supplier TEXT NOT NULL,
  supplier_sku TEXT,
  available_quantity REAL,
  minimum_order_quantity REAL,
  order_multiple REAL,
  in_stock_now INTEGER,
  stock_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  lead_time_days REAL,
  lead_time_text TEXT,
  currency TEXT,
  product_url TEXT,
  source_tool TEXT,
  raw_json TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offer_snapshots_mpn_checked ON offer_snapshots(mpn, checked_at DESC);

CREATE TABLE IF NOT EXISTS offer_price_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_snapshot_id INTEGER NOT NULL REFERENCES offer_snapshots(id) ON DELETE CASCADE,
  minimum_quantity REAL NOT NULL CHECK (minimum_quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  currency TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offer_price_tiers_offer ON offer_price_tiers(offer_snapshot_id, minimum_quantity);

CREATE TABLE IF NOT EXISTS procurement_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  production_quantity REAL NOT NULL CHECK (production_quantity > 0),
  mode TEXT NOT NULL,
  deadline_days REAL,
  currency TEXT,
  component_total REAL,
  supplier_count INTEGER,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procurement_run_id INTEGER NOT NULL REFERENCES procurement_runs(id) ON DELETE CASCADE,
  mpn TEXT NOT NULL COLLATE NOCASE,
  required_quantity REAL NOT NULL,
  supplier TEXT,
  order_quantity REAL,
  unit_price REAL,
  line_total REAL,
  lead_time_days REAL,
  status TEXT NOT NULL,
  offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_procurement_items_run ON procurement_items(procurement_run_id);
