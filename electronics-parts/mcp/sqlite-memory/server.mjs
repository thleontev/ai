import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DB_PATH = process.env.ELECTRONICS_PARTS_DB || path.resolve(process.cwd(), 'electronics-parts.db');
const SCHEMA_PATH = process.env.ELECTRONICS_PARTS_SCHEMA || path.resolve(process.cwd(), '../../db/schema.sql');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

if (fs.existsSync(SCHEMA_PATH)) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

const server = new McpServer({ name: 'sqlite-memory', version: '0.1.0' });

const verificationStatusSchema = z.enum(['VERIFIED', 'INFERRED', 'UNVERIFIED', 'CONFLICT']);
const compatibilityClassSchema = z.enum([
  'EXACT_DROP_IN',
  'QUALIFIED_DROP_IN',
  'CIRCUIT_COMPATIBLE',
  'FOOTPRINT_COMPATIBLE',
  'FUNCTIONAL_ALTERNATIVE',
  'REDESIGN_ALTERNATIVE',
  'REJECTED',
  'UNVERIFIED'
]);
const riskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']);
const sourceTypeSchema = z.enum([
  'MANUFACTURER_DATASHEET',
  'MANUFACTURER_PAGE',
  'AUTHORIZED_DISTRIBUTOR',
  'DISTRIBUTOR_CATALOG',
  'AGGREGATOR',
  'OTHER'
]);

function getProjectId(projectName) {
  if (!projectName) return null;
  db.prepare('INSERT INTO projects(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(projectName);
  return db.prepare('SELECT id FROM projects WHERE name=?').get(projectName)?.id ?? null;
}

function requirementCode(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function requireVerifiedDropIn(input) {
  if (!['EXACT_DROP_IN', 'QUALIFIED_DROP_IN', 'DROP_IN'].includes(input.replacement_class)) return;
  const statuses = [input.electrical_status, input.package_status, input.pinout_status, input.pcb_status];
  if (statuses.some((status) => status !== 'VERIFIED')) {
    throw new Error('Для DROP_IN требуются VERIFIED-оценки электрических параметров, корпуса, распиновки и влияния на PCB.');
  }
  const verifiedCodes = new Set(
    (input.evidence ?? [])
      .filter((e) => e.verification_status === 'VERIFIED')
      .map((e) => requirementCode(e.requirement_code ?? e.parameter_name ?? ''))
  );
  for (const required of ['package', 'pinout', ...(input.hard_requirement_codes ?? [])]) {
    if (!verifiedCodes.has(requirementCode(required))) {
      throw new Error(`Для DROP_IN отсутствует VERIFIED-доказательство требования: ${required}.`);
    }
  }
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

server.tool('create_project', 'Create or return a project by name.', {
  name: z.string().min(1),
  description: z.string().optional()
}, async ({ name, description }) => {
  db.prepare(`INSERT INTO projects(name, description) VALUES (?, ?)
              ON CONFLICT(name) DO UPDATE SET description=COALESCE(excluded.description, projects.description)`).run(name, description ?? null);
  return jsonResult(db.prepare('SELECT * FROM projects WHERE name=?').get(name));
});

server.tool('create_bom', 'Create a BOM and persist normalized BOM items.', {
  project_name: z.string().optional(),
  name: z.string().min(1),
  revision: z.string().optional(),
  source_filename: z.string().optional(),
  items: z.array(z.object({
    mpn: z.string().min(1),
    qty_per_unit: z.number().positive(),
    reference: z.string().optional(),
    notes: z.string().optional()
  })).min(1)
}, async ({ project_name, name, revision, source_filename, items }) => {
  const tx = db.transaction(() => {
    let projectId = null;
    if (project_name) {
      db.prepare('INSERT INTO projects(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(project_name);
      projectId = db.prepare('SELECT id FROM projects WHERE name=?').get(project_name)?.id ?? null;
    }
    const info = db.prepare('INSERT INTO boms(project_id,name,revision,source_filename) VALUES (?,?,?,?)')
      .run(projectId, name, revision ?? null, source_filename ?? null);
    const bomId = Number(info.lastInsertRowid);
    const upsertPart = db.prepare(`INSERT INTO parts(mpn) VALUES (?) ON CONFLICT(mpn) DO UPDATE SET updated_at=datetime('now')`);
    const partIdStmt = db.prepare('SELECT id FROM parts WHERE mpn=? COLLATE NOCASE');
    const insertItem = db.prepare('INSERT INTO bom_items(bom_id,part_id,mpn,qty_per_unit,reference,notes) VALUES (?,?,?,?,?,?)');
    for (const item of items) {
      upsertPart.run(item.mpn);
      const partId = partIdStmt.get(item.mpn)?.id ?? null;
      insertItem.run(bomId, partId, item.mpn, item.qty_per_unit, item.reference ?? null, item.notes ?? null);
    }
    return bomId;
  });
  const bomId = tx();
  return jsonResult({ bom_id: bomId, item_count: items.length });
});

server.tool('get_bom', 'Get a BOM and normalized items.', {
  bom_id: z.number().int().positive()
}, async ({ bom_id }) => {
  const bom = db.prepare('SELECT * FROM boms WHERE id=?').get(bom_id);
  const items = db.prepare('SELECT * FROM bom_items WHERE bom_id=? ORDER BY id').all(bom_id);
  return jsonResult({ bom, items });
});

server.tool('store_offers', 'Store normalized offer snapshots for an MPN.', {
  mpn: z.string().min(1),
  source_tool: z.string().optional(),
  offers: z.array(z.object({
    supplier: z.string().min(1),
    supplier_sku: z.string().optional(),
    available_quantity: z.number().nullable().optional(),
    minimum_order_quantity: z.number().nullable().optional(),
    order_multiple: z.number().nullable().optional(),
    unit_price: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    price_break_quantity: z.number().nullable().optional(),
    lead_time_days: z.number().nullable().optional(),
    lead_time_text: z.string().nullable().optional(),
    in_stock_now: z.boolean().nullable().optional(),
    product_url: z.string().nullable().optional(),
    raw_json: z.string().optional()
  })).min(1)
}, async ({ mpn, source_tool, offers }) => {
  db.prepare(`INSERT INTO parts(mpn) VALUES (?) ON CONFLICT(mpn) DO UPDATE SET updated_at=datetime('now')`).run(mpn);
  const partId = db.prepare('SELECT id FROM parts WHERE mpn=? COLLATE NOCASE').get(mpn)?.id ?? null;
  const stmt = db.prepare(`INSERT INTO offers(part_id,mpn,supplier,supplier_sku,available_quantity,minimum_order_quantity,order_multiple,unit_price,currency,price_break_quantity,lead_time_days,lead_time_text,in_stock_now,product_url,source_tool,raw_json)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const o of offers) stmt.run(partId, mpn, o.supplier, o.supplier_sku ?? null, o.available_quantity ?? null,
      o.minimum_order_quantity ?? null, o.order_multiple ?? null, o.unit_price ?? null, o.currency ?? null,
      o.price_break_quantity ?? null, o.lead_time_days ?? null, o.lead_time_text ?? null,
      o.in_stock_now == null ? null : (o.in_stock_now ? 1 : 0), o.product_url ?? null, source_tool ?? null, o.raw_json ?? null);
  });
  tx();
  return jsonResult({ stored: offers.length, mpn });
});

server.tool('get_recent_offers', 'Read recent offer snapshots for an MPN. ttl_minutes controls freshness.', {
  mpn: z.string().min(1),
  ttl_minutes: z.number().int().positive().default(30)
}, async ({ mpn, ttl_minutes }) => {
  const rows = db.prepare(`SELECT * FROM offers
    WHERE mpn=? COLLATE NOCASE AND checked_at >= datetime('now', ?)
    ORDER BY checked_at DESC, supplier`).all(mpn, `-${ttl_minutes} minutes`);
  return jsonResult({ mpn, ttl_minutes, offers: rows });
});

server.tool('save_search_run', 'Persist a summarized user operation for regression/debugging.', {
  project_name: z.string().optional(),
  task_type: z.enum(['PART_SEARCH','BOM_AVAILABILITY','BOM_PROCUREMENT','PART_REPLACEMENT']),
  query_text: z.string().optional(),
  requested_quantity: z.number().nullable().optional(),
  deadline_days: z.number().nullable().optional(),
  status: z.string().default('completed'),
  result_summary: z.string().optional()
}, async ({ project_name, task_type, query_text, requested_quantity, deadline_days, status, result_summary }) => {
  let projectId = null;
  if (project_name) {
    db.prepare('INSERT INTO projects(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(project_name);
    projectId = db.prepare('SELECT id FROM projects WHERE name=?').get(project_name)?.id ?? null;
  }
  const info = db.prepare(`INSERT INTO search_runs(project_id,task_type,query_text,requested_quantity,deadline_days,status,result_summary)
                           VALUES (?,?,?,?,?,?,?)`).run(projectId, task_type, query_text ?? null, requested_quantity ?? null,
                           deadline_days ?? null, status, result_summary ?? null);
  return jsonResult({ id: Number(info.lastInsertRowid) });
});

server.tool('save_replacement', 'Upsert a replacement candidate and its evidence.', {
  original_mpn: z.string().min(1),
  candidate_mpn: z.string().min(1),
  replacement_class: z.enum(['DROP_IN','PIN_COMPATIBLE','FUNCTIONAL','REDESIGN','REJECTED']),
  electrical_status: verificationStatusSchema.optional(),
  package_status: verificationStatusSchema.optional(),
  pinout_status: verificationStatusSchema.optional(),
  pcb_status: verificationStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  verification_status: verificationStatusSchema,
  reason: z.string().optional(),
  evidence: z.array(z.object({
    parameter_name: z.string(),
    original_value: z.string().optional(),
    candidate_value: z.string().optional(),
    requirement: z.string().optional(),
    result: z.string().optional(),
    source: z.string().optional(),
    source_url: z.string().optional(),
    source_page: z.string().optional(),
    verification_status: verificationStatusSchema,
    notes: z.string().optional()
  })).default([])
}, async (input) => {
  requireVerifiedDropIn(input);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO replacements(original_mpn,candidate_mpn,replacement_class,electrical_status,package_status,pinout_status,pcb_status,confidence,verification_status,reason)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(original_mpn,candidate_mpn) DO UPDATE SET
      replacement_class=excluded.replacement_class,electrical_status=excluded.electrical_status,
      package_status=excluded.package_status,pinout_status=excluded.pinout_status,pcb_status=excluded.pcb_status,
      confidence=excluded.confidence,verification_status=excluded.verification_status,reason=excluded.reason,updated_at=datetime('now')`)
      .run(input.original_mpn,input.candidate_mpn,input.replacement_class,input.electrical_status ?? null,
      input.package_status ?? null,input.pinout_status ?? null,input.pcb_status ?? null,input.confidence ?? null,
      input.verification_status,input.reason ?? null);
    const id = db.prepare('SELECT id FROM replacements WHERE original_mpn=? COLLATE NOCASE AND candidate_mpn=? COLLATE NOCASE')
      .get(input.original_mpn,input.candidate_mpn).id;
    db.prepare('DELETE FROM replacement_evidence WHERE replacement_id=?').run(id);
    const ev = db.prepare(`INSERT INTO replacement_evidence(replacement_id,parameter_name,original_value,candidate_value,requirement,result,source,source_url,source_page,verification_status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const e of input.evidence) ev.run(id,e.parameter_name,e.original_value ?? null,e.candidate_value ?? null,e.requirement ?? null,
      e.result ?? null,e.source ?? null,e.source_url ?? null,e.source_page ?? null,e.verification_status,e.notes ?? null);
    return id;
  });
  return jsonResult({ replacement_id: tx() });
});

server.tool('get_replacements', 'Get previously evaluated replacement candidates.', {
  original_mpn: z.string().min(1)
}, async ({ original_mpn }) => {
  const replacements = db.prepare('SELECT * FROM replacements WHERE original_mpn=? COLLATE NOCASE ORDER BY updated_at DESC').all(original_mpn);
  for (const r of replacements) {
    r.evidence = db.prepare('SELECT * FROM replacement_evidence WHERE replacement_id=? ORDER BY id').all(r.id);
  }
  return jsonResult({ original_mpn, replacements });
});

server.tool('create_application_profile', 'Create an application context used to qualify component replacements.', {
  project_name: z.string().optional(),
  name: z.string().min(1),
  context: z.record(z.string(), z.unknown())
}, async ({ project_name, name, context }) => {
  const projectId = getProjectId(project_name);
  const info = db.prepare(`INSERT INTO application_profiles(project_id,name,context_json)
    VALUES (?,?,?)`).run(projectId, name, JSON.stringify(context));
  return jsonResult({ application_profile_id: Number(info.lastInsertRowid) });
});

server.tool('get_application_profile', 'Read an application context by id.', {
  application_profile_id: z.number().int().positive()
}, async ({ application_profile_id }) => {
  const profile = db.prepare('SELECT * FROM application_profiles WHERE id=?').get(application_profile_id);
  if (!profile) throw new Error(`Профиль применения ${application_profile_id} не найден.`);
  return jsonResult({ ...profile, context: JSON.parse(profile.context_json) });
});

server.tool('start_replacement_run', 'Start an append-only replacement research run with the applied requirements.', {
  original_mpn: z.string().min(1),
  application_profile_id: z.number().int().positive().optional(),
  application_context: z.record(z.string(), z.unknown()).default({}),
  hard_constraints: z.array(z.string().min(1)).default([]),
  soft_preferences: z.array(z.string().min(1)).default([]),
  search_coverage: z.record(z.string(), z.unknown()).default({})
}, async ({ original_mpn, application_profile_id, application_context, hard_constraints, soft_preferences, search_coverage }) => {
  if (application_profile_id && !db.prepare('SELECT 1 FROM application_profiles WHERE id=?').get(application_profile_id)) {
    throw new Error(`Профиль применения ${application_profile_id} не найден.`);
  }
  const info = db.prepare(`INSERT INTO replacement_runs(
    original_mpn,application_profile_id,application_context_json,hard_constraints_json,soft_preferences_json,search_coverage_json)
    VALUES (?,?,?,?,?,?)`).run(
    original_mpn,
    application_profile_id ?? null,
    JSON.stringify(application_context),
    JSON.stringify(hard_constraints),
    JSON.stringify(soft_preferences),
    JSON.stringify(search_coverage)
  );
  return jsonResult({ replacement_run_id: Number(info.lastInsertRowid), status: 'IN_PROGRESS' });
});

server.tool('save_replacement_assessment', 'Save one candidate assessment without overwriting evidence from other research runs.', {
  replacement_run_id: z.number().int().positive(),
  candidate_mpn: z.string().min(1),
  manufacturer: z.string().optional(),
  replacement_class: compatibilityClassSchema,
  electrical_status: verificationStatusSchema,
  package_status: verificationStatusSchema,
  pinout_status: verificationStatusSchema,
  pcb_status: verificationStatusSchema,
  qualification_status: z.enum(['SAME', 'UPGRADE', 'DOWNGRADE', 'DIFFERENT', 'UNKNOWN']).default('UNKNOWN'),
  second_source_status: z.enum(['YES', 'NO_SAME_MANUFACTURER', 'NO', 'UNKNOWN']).default('UNKNOWN'),
  evidence_completeness: z.number().int().min(0).max(100),
  electrical_risk: riskSchema.default('UNKNOWN'),
  pcb_risk: riskSchema.default('UNKNOWN'),
  thermal_risk: riskSchema.default('UNKNOWN'),
  emi_risk: riskSchema.default('UNKNOWN'),
  supply_risk: riskSchema.default('UNKNOWN'),
  recommendation: z.string().optional(),
  hard_requirement_codes: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.object({
    requirement_code: z.string().min(1),
    requirement_name: z.string().min(1),
    original_value: z.string().optional(),
    candidate_value: z.string().optional(),
    result: z.string().min(1),
    source_type: sourceTypeSchema,
    source_name: z.string().optional(),
    source_url: z.string().url().optional(),
    source_locator: z.string().optional(),
    source_revision: z.string().optional(),
    verification_status: verificationStatusSchema,
    checked_at: z.string().datetime().optional(),
    notes: z.string().optional()
  })).default([])
}, async (input) => {
  if (!db.prepare('SELECT 1 FROM replacement_runs WHERE id=?').get(input.replacement_run_id)) {
    throw new Error(`Исследование замены ${input.replacement_run_id} не найдено.`);
  }
  requireVerifiedDropIn(input);
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO replacement_assessments(
      replacement_run_id,candidate_mpn,manufacturer,compatibility_class,electrical_status,package_status,pinout_status,pcb_status,
      qualification_status,second_source_status,evidence_completeness,electrical_risk,pcb_risk,thermal_risk,emi_risk,supply_risk,recommendation)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.replacement_run_id,input.candidate_mpn,input.manufacturer ?? null,input.replacement_class,
      input.electrical_status,input.package_status,input.pinout_status,input.pcb_status,input.qualification_status,
      input.second_source_status,input.evidence_completeness,input.electrical_risk,input.pcb_risk,input.thermal_risk,
      input.emi_risk,input.supply_risk,input.recommendation ?? null
    );
    const assessmentId = Number(info.lastInsertRowid);
    const insertEvidence = db.prepare(`INSERT INTO replacement_evidence_v2(
      assessment_id,requirement_code,requirement_name,original_value,candidate_value,result,source_type,source_name,source_url,
      source_locator,source_revision,verification_status,checked_at,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const evidence of input.evidence) {
      insertEvidence.run(
        assessmentId,evidence.requirement_code,evidence.requirement_name,evidence.original_value ?? null,evidence.candidate_value ?? null,
        evidence.result,evidence.source_type,evidence.source_name ?? null,evidence.source_url ?? null,evidence.source_locator ?? null,
        evidence.source_revision ?? null,evidence.verification_status,evidence.checked_at ?? new Date().toISOString(),evidence.notes ?? null
      );
    }
    return assessmentId;
  });
  return jsonResult({ assessment_id: tx() });
});

server.tool('complete_replacement_run', 'Complete a replacement research run after candidates and evidence are saved.', {
  replacement_run_id: z.number().int().positive(),
  conclusion: z.string().min(1),
  status: z.enum(['COMPLETED', 'INCONCLUSIVE', 'BLOCKED']).default('COMPLETED')
}, async ({ replacement_run_id, conclusion, status }) => {
  const info = db.prepare(`UPDATE replacement_runs SET status=?, conclusion=?, completed_at=datetime('now') WHERE id=?`)
    .run(status, conclusion, replacement_run_id);
  if (!info.changes) throw new Error(`Исследование замены ${replacement_run_id} не найдено.`);
  return jsonResult({ replacement_run_id, status });
});

server.tool('get_replacement_run', 'Read a replacement research run, its candidate assessments and append-only evidence.', {
  replacement_run_id: z.number().int().positive()
}, async ({ replacement_run_id }) => {
  const run = db.prepare('SELECT * FROM replacement_runs WHERE id=?').get(replacement_run_id);
  if (!run) throw new Error(`Исследование замены ${replacement_run_id} не найдено.`);
  const assessments = db.prepare('SELECT * FROM replacement_assessments WHERE replacement_run_id=? ORDER BY id').all(replacement_run_id);
  for (const assessment of assessments) {
    assessment.evidence = db.prepare('SELECT * FROM replacement_evidence_v2 WHERE assessment_id=? ORDER BY id').all(assessment.id);
  }
  return jsonResult({
    ...run,
    application_context: JSON.parse(run.application_context_json),
    hard_constraints: JSON.parse(run.hard_constraints_json),
    soft_preferences: JSON.parse(run.soft_preferences_json),
    search_coverage: JSON.parse(run.search_coverage_json),
    assessments
  });
});

server.tool('store_offer_snapshot', 'Store one supplier offer with grouped price tiers and an explicit stock type.', {
  mpn: z.string().min(1),
  supplier: z.string().min(1),
  supplier_sku: z.string().optional(),
  available_quantity: z.number().nullable().optional(),
  minimum_order_quantity: z.number().nullable().optional(),
  order_multiple: z.number().nullable().optional(),
  in_stock_now: z.boolean().nullable().optional(),
  stock_type: z.enum(['LOCAL_STOCK', 'PARTNER_STOCK', 'ORDER', 'UNKNOWN']).default('UNKNOWN'),
  lead_time_days: z.number().nullable().optional(),
  lead_time_text: z.string().nullable().optional(),
  currency: z.string().min(1),
  product_url: z.string().url().optional(),
  source_tool: z.string().optional(),
  raw_json: z.string().optional(),
  price_tiers: z.array(z.object({
    minimum_quantity: z.number().positive(),
    unit_price: z.number().nonnegative()
  })).min(1)
}, async (input) => {
  db.prepare(`INSERT INTO parts(mpn) VALUES (?) ON CONFLICT(mpn) DO UPDATE SET updated_at=datetime('now')`).run(input.mpn);
  const partId = db.prepare('SELECT id FROM parts WHERE mpn=? COLLATE NOCASE').get(input.mpn)?.id ?? null;
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO offer_snapshots(
      part_id,mpn,supplier,supplier_sku,available_quantity,minimum_order_quantity,order_multiple,in_stock_now,stock_type,
      lead_time_days,lead_time_text,currency,product_url,source_tool,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      partId,input.mpn,input.supplier,input.supplier_sku ?? null,input.available_quantity ?? null,input.minimum_order_quantity ?? null,
      input.order_multiple ?? null,input.in_stock_now == null ? null : (input.in_stock_now ? 1 : 0),input.stock_type,
      input.lead_time_days ?? null,input.lead_time_text ?? null,input.currency,input.product_url ?? null,input.source_tool ?? null,input.raw_json ?? null
    );
    const offerSnapshotId = Number(info.lastInsertRowid);
    const tier = db.prepare('INSERT INTO offer_price_tiers(offer_snapshot_id,minimum_quantity,unit_price,currency) VALUES (?,?,?,?)');
    for (const priceTier of input.price_tiers) tier.run(offerSnapshotId, priceTier.minimum_quantity, priceTier.unit_price, input.currency);
    return offerSnapshotId;
  });
  return jsonResult({ offer_snapshot_id: tx() });
});

server.tool('save_procurement_run', 'Persist a per-line procurement plan. All totals must use the declared single currency.', {
  bom_id: z.number().int().positive(),
  production_quantity: z.number().positive(),
  mode: z.enum(['CHEAPEST', 'FASTEST', 'BALANCED']),
  deadline_days: z.number().positive().nullable().optional(),
  currency: z.string().min(1),
  component_total: z.number().nonnegative(),
  unavailable_count: z.number().int().nonnegative().default(0),
  items: z.array(z.object({
    mpn: z.string().min(1),
    required_quantity: z.number().positive(),
    supplier: z.string().optional(),
    order_quantity: z.number().positive().nullable().optional(),
    unit_price: z.number().nonnegative().nullable().optional(),
    line_total: z.number().nonnegative().nullable().optional(),
    lead_time_days: z.number().nonnegative().nullable().optional(),
    status: z.string().min(1),
    offer_id: z.number().int().positive().nullable().optional(),
    notes: z.string().optional(),
    currency: z.string().min(1)
  })).min(1)
}, async (input) => {
  if (!db.prepare('SELECT 1 FROM boms WHERE id=?').get(input.bom_id)) throw new Error(`BOM ${input.bom_id} не найдена.`);
  if (input.items.some((item) => item.currency !== input.currency)) {
    throw new Error('Суммы в разных валютах нельзя сравнивать без отдельно сохранённого снимка курса конвертации.');
  }
  const tx = db.transaction(() => {
    const supplierCount = new Set(input.items.map((item) => item.supplier).filter(Boolean)).size;
    const info = db.prepare(`INSERT INTO procurement_runs(
      bom_id,production_quantity,mode,deadline_days,currency,component_total,supplier_count,unavailable_count)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      input.bom_id,input.production_quantity,input.mode,input.deadline_days ?? null,input.currency,input.component_total,
      supplierCount,input.unavailable_count
    );
    const procurementRunId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(`INSERT INTO procurement_items(
      procurement_run_id,mpn,required_quantity,supplier,order_quantity,unit_price,line_total,lead_time_days,status,offer_id,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of input.items) {
      insertItem.run(procurementRunId,item.mpn,item.required_quantity,item.supplier ?? null,item.order_quantity ?? null,
        item.unit_price ?? null,item.line_total ?? null,item.lead_time_days ?? null,item.status,item.offer_id ?? null,item.notes ?? null);
    }
    return procurementRunId;
  });
  return jsonResult({ procurement_run_id: tx(), currency: input.currency });
});

const transport = new StdioServerTransport();
await server.connect(transport);
