/* Reproduction of the concurrent-edit bug, and the guard that must prevent it.
 *
 * Scenario: an admin has the tracker open. While it is open, someone edits the
 * Run Sheet directly in Google Sheets (inserts an activity). The admin then
 * clicks Save. Assignments are written by ABSOLUTE ROW NUMBER captured at load,
 * so every row below the insertion is now off by one.
 */
const assert = require('assert');

function sheetAfterInsert(rows, atIndex, newRow){
  const c = rows.map(r => r.slice()); c.splice(atIndex, 0, newRow); return c;
}
const HEADER = ["Start","End","Room","Description","Responsibilities","Team Member","Status"];
function baseSheet(){
  return [
    ["Event Running Order","","","","","",""],
    HEADER.slice(),
    ["12:00 - 14:00","","","","","",""],
    ["12:00","12:15","","BJAR Exec Arrival","","",""],
    ["14:30","15:15","Main auditorium","Keynote Speaker & Audience Q&A","Be on standby","",""],
    ["15:20","16:05","Track Room A","Breakout Sessions 1: Aspiring Researchers","MC role","",""]
  ];
}
const STATUS_COL = 6, TEAM_COL = 5;

/* what the client captured at load: keynote is sheet row 5 (1-indexed) */
const clientPayload = [{ row:5, members:"Ywione Darrell", status:"" }];

/* ---------------- current behaviour (no guard) ---------------- */
function saveNoGuard(sheet, payload){
  const out = sheet.map(r => r.slice());
  payload.forEach(p => { out[p.row-1][TEAM_COL] = p.members; out[p.row-1][STATUS_COL] = p.status; });
  return out;
}

/* ---------------- structural revision + guard (the fix) ---------------- */
const STRUCTURAL = [0,1,2,3,4];              // Start,End,Room,Description,Responsibilities
function structuralRev(sheet){
  const body = sheet.map(r => STRUCTURAL.map(i => String(r[i]==null?"":r[i]).trim()).join("\u0001")).join("\u0002");
  let h = 0; for (let i=0;i<body.length;i++){ h = (h*31 + body.charCodeAt(i)) >>> 0; }
  return "r" + h.toString(36) + "-" + sheet.length;
}
function saveGuarded(sheet, payload, baseRev, lock){
  if (lock && lock.active) return { ok:false, code:'locked', by:lock.by };
  const now = structuralRev(sheet);
  if (baseRev && baseRev !== now) return { ok:false, code:'stale', rev:now };
  return { ok:true, sheet: saveNoGuard(sheet, payload), rev:now };
}

/* ================================ TESTS ================================ */
let failures = 0;
function check(name, fn){
  try { fn(); console.log("  PASS  " + name); }
  catch(e){ failures++; console.log("  FAIL  " + name + "\n        " + e.message); }
}

console.log("\n[1] Demonstrate the bug: row insert during an open session");
const loaded = baseSheet();
const revAtLoad = structuralRev(loaded);
// someone inserts a new setup task above the keynote while the admin page is open
const edited = sheetAfterInsert(loaded, 4, ["13:00","13:30","","Volunteers Arrive & Staff Briefing","Brief staff","",""]);

check("unguarded save writes the assignment onto the WRONG activity", () => {
  const result = saveNoGuard(edited, clientPayload);
  const wrote = result[4];                       // row 5 is now the newly inserted row
  assert.strictEqual(wrote[3], "Volunteers Arrive & Staff Briefing");
  assert.strictEqual(wrote[TEAM_COL], "Ywione Darrell");   // assigned to the wrong task
  const keynote = result.find(r => /Keynote/.test(r[3]));
  assert.strictEqual(keynote[TEAM_COL], "");               // keynote silently left unstaffed
});

console.log("\n[2] The guard must catch it");
check("structural revision changes when a row is inserted", () => {
  assert.notStrictEqual(structuralRev(edited), revAtLoad);
});
check("guarded save REJECTS a stale write instead of corrupting", () => {
  const res = saveGuarded(edited, clientPayload, revAtLoad, null);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'stale');
});
check("guarded save still succeeds when nothing changed underneath", () => {
  const res = saveGuarded(loaded, clientPayload, revAtLoad, null);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sheet.find(r => /Keynote/.test(r[3]))[TEAM_COL], "Ywione Darrell");
});
check("an active edit lock blocks the save outright", () => {
  const res = saveGuarded(loaded, clientPayload, revAtLoad, {active:true, by:"kyaida@…"});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'locked');
});

console.log("\n[3] No false alarms from the app's own columns");
check("staff ticking Status does NOT change the structural revision", () => {
  const ticked = loaded.map(r => r.slice());
  ticked[4][STATUS_COL] = "Complete";
  assert.strictEqual(structuralRev(ticked), revAtLoad);
  assert.strictEqual(saveGuarded(ticked, clientPayload, revAtLoad, null).ok, true);
});
check("editing a Description DOES change the revision", () => {
  const renamed = loaded.map(r => r.slice());
  renamed[4][3] = "Keynote & Q&A (revised)";
  assert.notStrictEqual(structuralRev(renamed), revAtLoad);
});

console.log(failures ? `\n${failures} FAILING\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
