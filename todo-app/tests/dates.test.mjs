// Run with: npm test   (TZ is pinned in package.json so results are deterministic)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, fmtDue, relative, normalize, countTasks } from '../public/js/dates.js';

// Monday 2 Nov 2026, 10:00 local time
const NOW = new Date(2026, 10, 2, 10, 0).getTime();
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

const cases = [
  // [input, expected title, expected due]
  ['اتصل بماما بكرة الساعة ٥', 'اتصل بماما', at(3, 17)],
  ['دكتور الأسنان بكره ٥م', 'دكتور الأسنان', at(3, 17)],
  ['دكتور الأسنان بكرة 5', 'دكتور الأسنان', at(3, 17)],
  ['اجتماع الساعة ٩ الصبح', 'اجتماع', at(3, 9)], // 9 AM already passed today -> tomorrow
  ['اجتماع الساعة 9', 'اجتماع', at(2, 21)], // ambiguous 9 -> tonight
  ['ادفع فاتورة النت النهارده', 'ادفع فاتورة النت', at(2, 20)],
  ['ادفع فاتورة النت النهارده بالليل', 'ادفع فاتورة النت', at(2, 21)],
  ['جيم بعد ساعتين', 'جيم', at(2, 12)],
  ['اشرب مية بعد نص ساعة', 'اشرب مية', at(2, 10, 30)],
  ['تسليم المشروع يوم الخميس الساعة 3 العصر', 'تسليم المشروع', at(5, 15)],
  ['تسليم المشروع الخميس', 'تسليم المشروع', at(5, 9)],
  ['حلاق الاتنين الجاي ٦ ونص', 'حلاق', at(9, 18, 30)], // today is Monday -> next Monday
  ['عشا مع أحمد بعد بكرة الساعة ٨ بالليل', 'عشا مع أحمد', at(4, 20)],
  ['مقابلة 15/11 الساعة 11', 'مقابلة', at(15, 11)],
  ['ميعاد الدكتور ٢٠ نوفمبر ٤م', 'ميعاد الدكتور', at(20, 16)],
  ['call mom tomorrow at 5pm', 'call mom', at(3, 17)],
  ['gym in 30 minutes', 'gym', at(2, 10, 30)],
  ['submit report friday 10:30am', 'submit report', at(6, 10, 30)],
  ['اشتري ٣ كيلو طماطم', 'اشتري ٣ كيلو طماطم', null],
  ['ذاكر صفحة 5-10', 'ذاكر صفحة 5-10', null],
  ['اشتري بكره 3 كيلو طماطم', 'اشتري 3 كيلو طماطم', at(3, 9)],
  ['الساعة ٦ الا ربع اجتماع', 'اجتماع', at(2, 17, 45)],
  ['تمرين الصبح', 'تمرين', at(3, 9)],
  ['صلاة الضهر', 'صلاة', at(2, 12)],
];

for (const [input, title, due] of cases) {
  test(`parse: ${input}`, () => {
    const r = parseWhen(input, NOW);
    assert.equal(r.title, title);
    assert.equal(r.due, due, `got ${r.due && new Date(r.due).toString()}`);
  });
}

test('normalize keeps length (indices stay aligned)', () => {
  const s = 'بكرة الساعة ٥ إلا ربع 🙂';
  assert.equal(normalize(s).length, s.length);
});

test('formatting', () => {
  assert.equal(fmtDue(at(3, 17), NOW), 'بكرة ٥:٠٠ م');
  assert.equal(fmtDue(at(2, 9), NOW), 'النهارده ٩:٠٠ ص');
  assert.equal(relative(at(2, 12), NOW), 'كمان ساعتين');
  assert.equal(relative(at(2, 7), NOW), 'فاتت من ٣ ساعات');
  assert.equal(countTasks(1), 'مهمة واحدة');
  assert.equal(countTasks(5), '٥ مهام');
});
