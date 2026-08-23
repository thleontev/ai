import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'mcp', 'sqlite-memory', 'server.mjs');
const schemaPath = path.join(root, 'db', 'schema.sql');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'electronics-parts-test-'));

function createClient() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ELECTRONICS_PARTS_DB: path.join(tempDir, 'test.db'),
      ELECTRONICS_PARTS_SCHEMA: schemaPath
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  return { child, request, notify };
}

function textResult(result) {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
}

async function call(client, name, args) {
  return textResult(await client.request('tools/call', { name, arguments: args }));
}

async function main() {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'sqlite-memory-test', version: '1.0.0' }
    });
    client.notify('notifications/initialized', {});

    const run = await call(client, 'start_replacement_run', {
      original_mpn: 'AP63203WU-7',
      application_context: { vin_max: '5.5 V', vout: '3.3 V', pcb_change_allowed: false },
      hard_constraints: ['function', 'vin_max'],
      search_coverage: { manufacturers_checked: ['Diodes'] }
    });

    const validEvidence = ['package', 'pinout', 'function', 'vin_max'].map((requirement_code) => ({
      requirement_code,
      requirement_name: requirement_code,
      result: 'PASS',
      source_type: 'MANUFACTURER_DATASHEET',
      source_url: 'https://example.com/datasheet.pdf',
      verification_status: 'VERIFIED'
    }));

    await assert.rejects(
      call(client, 'save_replacement_assessment', {
        replacement_run_id: run.replacement_run_id,
        candidate_mpn: 'AP63203QWU-7',
        replacement_class: 'QUALIFIED_DROP_IN',
        electrical_status: 'VERIFIED',
        package_status: 'VERIFIED',
        pinout_status: 'VERIFIED',
        pcb_status: 'UNVERIFIED',
        evidence_completeness: 95,
        hard_requirement_codes: ['function', 'vin_max'],
        evidence: validEvidence
      }),
      /Для DROP_IN требуются VERIFIED/
    );

    await call(client, 'save_replacement_assessment', {
      replacement_run_id: run.replacement_run_id,
      candidate_mpn: 'AP63203QWU-7',
      replacement_class: 'QUALIFIED_DROP_IN',
      electrical_status: 'VERIFIED',
      package_status: 'VERIFIED',
      pinout_status: 'VERIFIED',
      pcb_status: 'VERIFIED',
      qualification_status: 'UPGRADE',
      second_source_status: 'NO_SAME_MANUFACTURER',
      evidence_completeness: 100,
      electrical_risk: 'LOW',
      pcb_risk: 'LOW',
      hard_requirement_codes: ['function', 'vin_max'],
      evidence: validEvidence
    });
    const savedRun = await call(client, 'get_replacement_run', { replacement_run_id: run.replacement_run_id });
    assert.equal(savedRun.assessments.length, 1);
    assert.equal(savedRun.assessments[0].compatibility_class, 'QUALIFIED_DROP_IN');
    assert.equal(savedRun.assessments[0].evidence.length, 4);

    const bom = await call(client, 'create_bom', {
      name: 'test-bom',
      items: [{ mpn: 'TEST-REG', qty_per_unit: 1 }]
    });
    const procurementItem = {
      mpn: 'TEST-REG',
      required_quantity: 10,
      supplier: 'Test supplier',
      order_quantity: 10,
      unit_price: 10,
      line_total: 100,
      status: 'AVAILABLE'
    };
    await assert.rejects(
      call(client, 'save_procurement_run', {
        bom_id: bom.bom_id,
        production_quantity: 10,
        mode: 'CHEAPEST',
        currency: 'RUB',
        component_total: 100,
        items: [{ ...procurementItem, currency: 'USD' }]
      }),
      /Суммы в разных валютах/
    );
    const procurement = await call(client, 'save_procurement_run', {
      bom_id: bom.bom_id,
      production_quantity: 10,
      mode: 'CHEAPEST',
      currency: 'RUB',
      component_total: 100,
      items: [{ ...procurementItem, currency: 'RUB' }]
    });
    assert.ok(procurement.procurement_run_id > 0);
    console.log('sqlite-memory integration tests passed');
  } finally {
    if (client.child.exitCode === null) {
      client.child.kill();
      await new Promise((resolve) => client.child.once('exit', resolve));
    }
  }
}

try {
  await main();
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
