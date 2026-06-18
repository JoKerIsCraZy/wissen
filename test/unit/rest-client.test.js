'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { pick, display, pickNum, pickText, parseDetail } = require('../../src/rest/client');

// ============================================================
// Echtes nice2-v2 Nested-Fixture (row.paths.<feld> = { type, value };
// Relationen verschachteln über value.paths). Bestätigte Live-Form.
// ============================================================
function nestedRow() {
  return {
    key: '84121',
    paths: {
      grade: { type: 'decimal', value: 4.5 },
      relInput: {
        type: 'entity',
        value: {
          paths: {
            relInput_node: {
              value: {
                paths: {
                  short: { value: 'GB-...' },
                  relInput_type: {
                    value: { paths: { unique_id: { value: 'grades' } } }
                  }
                }
              }
            },
            relEvent: { value: { paths: { label: { value: '254 - ...' } } } }
          }
        }
      }
    }
  };
}

test('pick: skalarer Pfad liefert den Wert', () => {
  const row = nestedRow();
  assert.strictEqual(pick(row, 'grade'), 4.5);
});

test('pick: verschachtelter Relations-Pfad (entity → entity)', () => {
  const row = nestedRow();
  assert.strictEqual(pick(row, 'relInput.relInput_node.short'), 'GB-...');
  assert.strictEqual(pick(row, 'relInput.relInput_node.relInput_type.unique_id'), 'grades');
  assert.strictEqual(pick(row, 'relInput.relEvent.label'), '254 - ...');
});

test('pick: unbekannter Pfad → undefined (nie werfend)', () => {
  const row = nestedRow();
  assert.strictEqual(pick(row, 'relInput.does_not_exist.x'), undefined);
  assert.strictEqual(pick(null, 'grade'), undefined);
});

test('display: macht Werte string-fähig, defensiv', () => {
  assert.strictEqual(display('GB-...'), 'GB-...');
  assert.strictEqual(display(4.5), '4.5');
  assert.strictEqual(display(null), '');
  assert.strictEqual(display(undefined), '');
  assert.strictEqual(display({ value: 'x' }), 'x');
  assert.strictEqual(display({ label: 'L' }), 'L');
});

test('pickText: pick + display kombiniert', () => {
  const row = nestedRow();
  assert.strictEqual(pickText(row, 'relInput.relInput_node.short'), 'GB-...');
  assert.strictEqual(pickText(row, 'relInput.does_not_exist'), '');
});

test('pickNum: numerischer Pfad → Zahl, sonst null', () => {
  const row = nestedRow();
  assert.strictEqual(pickNum(row, 'grade'), 4.5);
  assert.strictEqual(pickNum(row, 'relInput.relInput_node.short'), null);
  assert.strictEqual(pickNum(row, 'does_not_exist'), null);
});

// ============================================================
// parseDetail gegen ein echtes getDetailData-Wire-Sample.
// ============================================================
const WIRE_SAMPLE = `throw 'allowScriptTagRemoting is false.';
//#DWR-REPLY
//#DWR-START#
(function(){
if(!window.dwr)return;
var dwr=window.dwr._[0];
dwr.engine.remote.handleCallback("1","0",dwr.engine.remote.newObject("DwrResult",{createdEntities:[],deletedEntities:[],returnValue:{"definate_grade":"4.500","input_node":"GB-ZH-UIFZ-P-B21-03-IK-GE-254 - Geschäftsprozesse im eigenen Berufsumfeld beschreiben",exams:[dwr.engine.remote.newObject("nice2.optional.qualification.ExamRecord",{average:5.448,date:null,defaultDisplay:"ZP",label:"ZP",nr:1,pk:"28786",pointsMax:0.000,weight:30.00}),dwr.engine.remote.newObject("nice2.optional.qualification.ExamRecord",{average:4.813,date:null,defaultDisplay:"LB",label:"LB",nr:2,pk:"28787",pointsMax:0.000,weight:70.00})],"num_ratings":2,dispense:false,ratings:[dwr.engine.remote.newObject("nice2.optional.qualification.RatingRecord",{defaultDisplay:"5.900",id:1,pk:"146104",value:5.900}),dwr.engine.remote.newObject("nice2.optional.qualification.RatingRecord",{defaultDisplay:"4.200",id:2,pk:"146105",value:4.200})],"num_drop_ratings":null,name:"Elio",input_type:"Noten",events:"32360 \\/ UIFZ-2524-020-S1-254 \\/ 254 - Geschäftsprozesse im eigenen Berufsumfeld beschreiben"}}));
})();`;

test('parseDetail: grade / num / events', () => {
  const d = parseDetail(WIRE_SAMPLE);
  assert.strictEqual(d.grade, 4.5);
  assert.strictEqual(d.num, 2);
  assert.strictEqual(d.events, '32360 / UIFZ-2524-020-S1-254 / 254 - Geschäftsprozesse im eigenen Berufsumfeld beschreiben');
});

test('parseDetail: exams ZP/LB mit Gewicht + Durchschnitt', () => {
  const d = parseDetail(WIRE_SAMPLE);
  assert.strictEqual(d.exams.length, 2);
  assert.deepStrictEqual(
    d.exams.map((e) => ({ label: e.label, nr: e.nr, weight: e.weight, average: e.average })),
    [
      { label: 'ZP', nr: 1, weight: 30, average: 5.448 },
      { label: 'LB', nr: 2, weight: 70, average: 4.813 }
    ]
  );
});

test('parseDetail: ratings values 5.9 / 4.2', () => {
  const d = parseDetail(WIRE_SAMPLE);
  assert.strictEqual(d.ratings.length, 2);
  assert.strictEqual(d.ratings[0].value, 5.9);
  assert.strictEqual(d.ratings[1].value, 4.2);
});
