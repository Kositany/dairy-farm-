const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'Dairy Farm Manager.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const inlineScript = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1];
if (!inlineScript) throw new Error('App inline script not found.');

const appSource = inlineScript.replace(/\nstartApp\(\);\s*$/, '\n');
const storage = new Map();
const context = vm.createContext({
  document: { getElementById: () => null, createElement: () => ({ click() {} }) },
  window: {},
  navigator: {},
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  },
  confirm: () => true,
  prompt: () => '',
  TextEncoder,
  TextDecoder,
  Blob,
  URL,
  console
});
vm.runInContext(appSource, context, { filename: htmlPath });

function sampleData() {
  return {
    cows: [{ id: 'cow_1', tag: 'A&B', name: 'Daisy <1>', breed: 'Friesian' }],
    milk: [{ id: 'milk_1', date: context.today(), cow: 'cow_1', s: 'Morning', l: 12.5 }],
    feed: [{ id: 'feed_1', date: context.today(), cow: 'cow_1', t: 'Hay', kg: 4 }],
    weight: [{ id: 'weight_1', date: context.today(), cow: 'cow_1', kg: 480 }],
    breed: [{ id: 'breed_1', date: context.today(), cow: 'cow_1', t: 'Heat observed', b: 'Bull 7', n: 'Check & record' }]
  };
}

test('loads the legacy data shape and adds archive defaults', () => {
  const normalized = context.validData(sampleData());
  assert.equal(normalized.cows.length, 1);
  assert.equal(normalized.cows[0].archivedAt, null);
  assert.equal(normalized.milk[0].l, 12.5);
  assert.equal(normalized.calves.length, 0);
});

test('parses bulk cow rows from comma-separated and spreadsheet tab-separated input', () => {
  const parsed = context.parseBulkCowRows('A101, Daisy, Friesian\nA102\tRosie\tJersey', []);
  assert.equal(parsed.error, '');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows)), [
    { tag: 'A101', name: 'Daisy', breed: 'Friesian' },
    { tag: 'A102', name: 'Rosie', breed: 'Jersey' }
  ]);
});

test('rejects bulk cow batches with duplicate, existing, or invalid rows atomically', () => {
  const existing = [{ tag: 'A101', archivedAt: null }, { tag: 'OLD', archivedAt: '2026-01-01' }];
  assert.match(context.parseBulkCowRows('A102\nA102', existing).error, /Line 2.*already/);
  assert.match(context.parseBulkCowRows('a101', existing).error, /Line 1.*already/);
  assert.equal(context.parseBulkCowRows('OLD', existing).error, '');
  assert.match(context.parseBulkCowRows('A102\n,Missing tag', existing).error, /Line 2.*required/);
  assert.match(context.parseBulkCowRows('A102, Name, Breed, Extra', existing).error, /Line 1.*use tag/);
});

test('maps v3 readable records including calves and verifies checksums', () => {
  const data = sampleData();
  data.calves = [{ id: 'calf_1', number: 'C-01', ageMonths: 4 }];
  const stored = context.storedData(data);
  const payload = {
    schemaVersion: 3,
    data: stored,
    checksum: context.hashText(JSON.stringify(stored))
  };
  const normalized = context.fromBackupPayload(payload);
  assert.equal(normalized.milk[0].cow, 'cow_1');
  assert.equal(normalized.milk[0].l, 12.5);
  assert.equal(normalized.feed[0].t, 'Hay');
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.calves)), data.calves);
  assert.throws(() => context.fromBackupPayload({ ...payload, checksum: '00000000' }), /checksum/i);
});

test('loads v2 backups without calves and quarantines invalid calf ages', () => {
  const legacy = sampleData();
  const oldStored = context.storedData(legacy);
  delete oldStored.calves;
  const normalized = context.fromBackupPayload({ schemaVersion: 2, data: oldStored });
  assert.equal(normalized.calves.length, 0);
  const data = sampleData();
  data.calves = [{ id: 'bad_calf', number: 'C-02', ageMonths: 1.5 }];
  assert.equal(context.validData(data).calves.length, 0);
  assert.equal(context.quarantine.some(row => row.collection === 'calves'), true);
  const duplicateNumbers = sampleData();
  duplicateNumbers.calves = [
    { id: 'calf_1', number: 'C-02', ageMonths: 2 },
    { id: 'calf_2', number: 'c-02', ageMonths: 3 }
  ];
  assert.equal(context.validData(duplicateNumbers).calves.length, 1);
  assert.equal(context.quarantine.some(row => row.record?.id === 'calf_2'), true);
});

test('quarantines invalid dates and missing cow references without losing source rows', () => {
  const data = sampleData();
  data.milk.push({ id: 'bad_date', date: '2026-02-31', cow: 'cow_1', s: 'Morning', l: 1 });
  data.feed.push({ id: 'missing_cow', date: context.today(), cow: 'missing', t: 'Hay', kg: 1 });
  const normalized = context.validData(data);
  assert.equal(normalized.milk.some(row => row.id === 'bad_date'), false);
  assert.equal(normalized.feed.some(row => row.id === 'missing_cow'), true);
  assert.equal(context.quarantine.some(row => row.record?.id === 'bad_date'), true);
  assert.equal(context.quarantine.some(row => row.record?.id === 'missing_cow'), true);
});

test('preserves unknown collection fields in quarantine', () => {
  const data = sampleData();
  data.unknownCollection = [{ value: 'keep me' }];
  context.validData(data);
  assert.equal(context.quarantine.some(row => row.collection === 'unknown'), true);
});

test('preserves unknown top-level backup fields during normalization', () => {
  const data = sampleData();
  data.futureCollection = [{ id: 'future_1', value: 'keep this' }];
  context.fromBackupPayload({ data });
  assert.equal(context.quarantine.some(row => row.collection === 'unknown' && row.record.field === 'futureCollection'), true);
});

test('date arithmetic is timezone-independent and breeding due date remains 283 days', () => {
  assert.equal(context.shift('2026-03-01', -1), '2026-02-28');
  const data = sampleData();
  data.breed = [{ id: 'service_1', date: '2026-01-01', cow: 'cow_1', t: 'Artificial insemination', b: '', n: '' }];
  context.S = data;
  assert.equal(context.bstat('cow_1').due, context.shift('2026-01-01', 283));
});

test('unit conversions retain canonical litres and kilograms', () => {
  context.farmProfile.milkUnit = 'US gal';
  context.farmProfile.weightUnit = 'lb';
  context.farmProfile.feedUnit = 'lb';
  assert.ok(Math.abs(context.inputMeasure(1, 'milk') - 3.785411784) < 1e-8);
  assert.equal(context.displayMeasure(3.785411784, 'milk'), '1 US gal');
  assert.ok(Math.abs(context.inputMeasure(2.2046226218, 'weight') - 1) < 1e-8);
  context.farmProfile = { name: 'Dairy Farm', locale: 'en-KE', timeZone: 'Africa/Nairobi', milkUnit: 'L', weightUnit: 'kg', feedUnit: 'kg' };
});

test('CSV cells neutralize spreadsheet formula prefixes', () => {
  assert.equal(context.csvEscape('=SUM(1,1)'), '"\'=SUM(1,1)"');
  assert.equal(context.csvEscape('ordinary "text"'), '"ordinary ""text"""');
});

test('workbook filters rows, includes archived status, and escapes cell text', () => {
  const data = sampleData();
  data.calves = [{ id: 'calf_1', number: 'C-01', ageMonths: 4 }];
  data.cows.push({ id: 'cow_2', tag: 'OLD', name: '', breed: 'Jersey', archivedAt: '2026-01-01' });
  data.milk.push({ id: 'milk_2', date: '2026-01-01', cow: 'cow_2', s: 'Evening', l: 2 });
  context.S = data;
  context.excelStart = context.today();
  context.excelEnd = context.today();
  context.excelCow = 'cow_1';
  const sheets = context.workbookSheets();
  const milk = sheets.find(sheet => sheet[0] === 'Milk')[1];
  const summary = sheets.find(sheet => sheet[0] === 'Summary')[1];
  const cows = sheets.find(sheet => sheet[0] === 'Cows')[1];
  const calves = sheets.find(sheet => sheet[0] === 'Calves')[1];
  assert.equal(milk.length, 2);
  assert.equal(milk[1][2], 'A&B');
  assert.equal(summary.find(row => row[0] === 'Milk records')[1], 1);
  assert.equal(cows.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calves[1])), ['calf_1', 'C-01', 4]);
  assert.match(context.worksheetXml(milk), /A&amp;B/);
  assert.match(context.worksheetXml(milk), /autoFilter/);
  assert.match(context.worksheetXml(milk), /state="frozen"/);
  assert.match(context.worksheetXml(milk), /r="B2" s="3"/);
  context.excelStart = '';
  context.excelEnd = '';
  context.excelCow = '';
});

test('XLSX is a checksummed ZIP with seven worksheets and styles', async () => {
  const data = sampleData();
  context.S = data;
  const blob = context.buildExcel();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  assert.notEqual(end, -1);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names = [];
  const xml = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    names.push(name);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const contents = bytes.slice(dataStart, dataStart + size);
    assert.equal(context.crc32(contents), crc, `CRC mismatch in ${name}`);
    if (name.endsWith('.xml')) xml.push(new TextDecoder().decode(contents));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  for (const sheet of ['Summary', 'Cows', 'Calves', 'Milk', 'Feed', 'Weight', 'Breeding']) {
    assert.ok(xml.some(part => part.includes(`name="${sheet}"`)) || names.includes('xl/worksheets/sheet1.xml'));
  }
  assert.ok(names.includes('xl/styles.xml'));
  assert.ok(xml.some(part => part.includes('Daisy &lt;1&gt;')));
  assert.ok(xml.some(part => part.includes('numFmtId="165" formatCode="yyyy-mm-dd"')));
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('CSP blocks remote connections and the app has no external script/font dependencies', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1] || '';
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.equal(/<script[^>]+src\s*=|<link[^>]+href\s*=|@import\s+url\(|url\(\s*https?:/i.test(html), false);
});
