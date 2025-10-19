// formFiller_scale_mcc_fixed.js
require('dotenv').config();
const puppeteer = require('puppeteer');
const { faker } = require('@faker-js/faker');

const FORM_URL = process.env.FORM_URL;
const SUBMISSIONS = parseInt(process.env.SUBMISSIONS || '10', 10);
const HEADLESS = (process.env.HEADLESS === 'true');
const TYPING_MIN = parseInt(process.env.TYPING_MIN || '30', 10);
const TYPING_MAX = parseInt(process.env.TYPING_MAX || '140', 10);

if (!FORM_URL) {
  console.error('Please set FORM_URL in .env');
  process.exit(1);
}

function randInt(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function randSleep(min=200, max=1200){ return sleep(randInt(min,max)); }

async function humanType(page, selector, text) {
  if (!selector) return;
  try {
    // focus specific inner input if present
    await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      const inner = el.querySelector('input, textarea, div[contenteditable="true"]') || el;
      inner.focus && inner.focus();
    }, selector);

    for (const ch of String(text)) {
      await page.keyboard.type(ch, { delay: randInt(TYPING_MIN, TYPING_MAX) });
    }
  } catch (e) {
    // fallback DOM set
    await page.evaluate((sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const inner = el.querySelector('input, textarea, div[contenteditable="true"]') || el;
      if (inner) {
        if (inner.tagName.toLowerCase()==='input' || inner.tagName.toLowerCase()==='textarea') {
          inner.value = txt;
          inner.dispatchEvent(new Event('input',{bubbles:true}));
        } else {
          inner.innerText = txt;
        }
      }
    }, selector, String(text));
  }
}

// click the N-th option inside a container selector (zero-indexed)
async function clickOptionByIndex(page, containerSelector, index) {
  return page.evaluate((sel, idx) => {
    const container = sel ? document.querySelector(sel) : null;
    const root = container || document;
    // Try typical radio options
    const radioCandidates = Array.from(root.querySelectorAll('div[role="radio"], .freebirdFormviewerViewItemsRadioOption, .quantumWizTogglePaperRadioOption, .docssharedWizToggleLabeledContainer'));
    if (radioCandidates.length) {
      const el = radioCandidates[idx];
      if (el) { el.click(); return true; }
    }
    // Try checkbox candidates
    const cbCandidates = Array.from(root.querySelectorAll('div[role="checkbox"], .freebirdFormviewerViewItemsCheckboxOption, .quantumWizTogglePaperCheckboxOption'));
    if (cbCandidates.length) {
      const el = cbCandidates[idx];
      if (el) { el.click(); return true; }
    }
    // fallback: any clickable child (span/div) inside container
    const clickable = Array.from((container || document).querySelectorAll('div, label, span, .freebirdFormviewerViewItemsItemItem'));
    const valid = clickable.filter(c => c && c.innerText && c.innerText.trim().length>0);
    if (valid.length && valid[idx]) { valid[idx].click(); return true; }
    return false;
  }, containerSelector, index);
}

// click option by text inside a container
async function clickOptionByText(page, containerSelector, text) {
  return page.evaluate((sel, txt) => {
    const container = sel ? document.querySelector(sel) : null;
    const root = container || document;
    const candidates = Array.from(root.querySelectorAll('div, label, span, .freebirdFormviewerViewItemsRadioOption, .freebirdFormviewerViewItemsCheckboxOption'));
    // exact match first
    let found = candidates.find(c => c.innerText && c.innerText.trim().toLowerCase() === txt.trim().toLowerCase());
    if (!found) found = candidates.find(c => c.innerText && c.innerText.trim().toLowerCase().includes(txt.trim().toLowerCase()));
    if (found) { found.click(); return true; }
    return false;
  }, containerSelector, text);
}

// parse questions and capture container selector + an input selector if present
async function parseQuestions(page) {
  return page.evaluate(() => {
    function getSelector(el) {
      if (!el) return null;
      if (el.id) return `#${el.id}`;
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 10) {
        let part = node.tagName.toLowerCase();
        if (node.className) {
          const cls = String(node.className).split(' ').filter(Boolean)[0];
          if (cls) part += '.' + cls.replace(/[^a-zA-Z0-9\-_]/g,'');
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          if (siblings.length > 1) {
            const idx = Array.from(parent.children).indexOf(node) + 1;
            part += `:nth-child(${idx})`;
          }
        }
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    // question containers commonly have role=listitem or a class
    const qNodes = Array.from(document.querySelectorAll('div[role="listitem"], .freebirdFormviewerViewItemsItemItem, .freebirdFormviewerViewItemsItem'));
    const questions = [];

    qNodes.forEach((qn, qi) => {
      const titleEl = qn.querySelector('.freebirdFormviewerViewItemsItemItemTitle, .m2, .Qr7Oae, .docssharedWizTitle') || qn.querySelector('h2, h3');
      const title = titleEl ? titleEl.innerText.trim() : `question_${qi}`;

      // direct text input
      const input = qn.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea, div[contenteditable="true"]');
      if (input) {
        questions.push({ idx: qi, type: input.tagName.toLowerCase()==='textarea' ? 'paragraph' : 'short_text', title, inputSelector: getSelector(input), containerSelector: getSelector(qn) });
        return;
      }

      // radio options (MCQ, also used by linear scale sometimes)
      const radioEls = Array.from(qn.querySelectorAll('div[role="radio"], .freebirdFormviewerViewItemsRadioOption, .quantumWizTogglePaperRadioOption, .docssharedWizToggleLabeledContainer'));
      if (radioEls && radioEls.length) {
        // capture inner option texts
        const opts = radioEls.map(r => (r.innerText || '').trim()).filter(Boolean);
        questions.push({ idx: qi, type: 'radio', title, options: opts, containerSelector: getSelector(qn) });
        return;
      }

      // checkbox groups
      const checkboxEls = Array.from(qn.querySelectorAll('div[role="checkbox"], .freebirdFormviewerViewItemsCheckboxOption, .quantumWizTogglePaperCheckboxOption'));
      if (checkboxEls && checkboxEls.length) {
        const opts = checkboxEls.map(c => (c.innerText || '').trim()).filter(Boolean);
        questions.push({ idx: qi, type: 'checkbox', title, options: opts, containerSelector: getSelector(qn) });
        return;
      }

      // select/dropdown
      const select = qn.querySelector('select');
      if (select) {
        const opts = Array.from(select.options).map(o => (o.text || '').trim()).filter(Boolean);
        questions.push({ idx: qi, type: 'dropdown', title, options: opts, inputSelector: getSelector(select), containerSelector: getSelector(qn) });
        return;
      }

      // date/time
      const date = qn.querySelector('input[type="date"]');
      if (date) { questions.push({ idx: qi, type: 'date', title, inputSelector: getSelector(date), containerSelector: getSelector(qn) }); return; }
      const time = qn.querySelector('input[type="time"]');
      if (time) { questions.push({ idx: qi, type: 'time', title, inputSelector: getSelector(time), containerSelector: getSelector(qn) }); return; }

      // fallback: container only
      questions.push({ idx: qi, type: 'short_text', title, containerSelector: getSelector(qn) });
    });

    return questions;
  });
}

// detect linear-scale-like questions (all options numeric or title contains 'scale'/'rate')
function isScaleQuestion(q) {
  if (!q) return false;
  const title = (q.title || '').toLowerCase();
  if (title.includes('scale') || title.includes('rate') || title.includes('1-') || title.includes('1 to')) return true;
  if (Array.isArray(q.options) && q.options.length && q.options.every(o => /^\d+(\s*[-–]\s*\d+)?$/.test(o.trim()))) return true;
  // if options are strictly numbers like '1', '2', ...
  if (Array.isArray(q.options) && q.options.length && q.options.every(o => /^\d+$/.test(o.trim()))) return true;
  return false;
}

// heuristics to choose an answer
async function chooseAnswer(q, page) {
  const t = (q.title || '').toLowerCase();
  if (q.type === 'short_text' || q.type === 'paragraph') {
    if (t.includes('name')) return `${faker.person.firstName()} ${faker.person.lastName()}`;
    if (t.includes('email')) return faker.internet.email();
    if (t.includes('phone') || t.includes('mobile')) return faker.phone.number('##########');
    if (t.includes('age')) return String(randInt(18,60));
    if (t.includes('city')) return faker.location.city();
    if (t.includes('country')) return faker.location.country();
    return faker.lorem.words(randInt(2,5));
  }
      // handle linear scale questions explicitly
    if (isScaleQuestion(q)) {
      const numericOpts = (q.options || []).map(o => (o || '').trim()).filter(o => /^\d+$/.test(o));
      if (numericOpts.length) {
        const pickIdx = randInt(0, numericOpts.length - 1);
        const ok = await page.evaluate((sel, idx) => {
          const container = sel ? document.querySelector(sel) : null;
          const radios = container
            ? container.querySelectorAll('div[role="radio"][data-value]')
            : document.querySelectorAll('div[role="radio"][data-value]');
          if (radios && radios[idx]) {
            radios[idx].click();
            return true;
          }
          return false;
        }, q.containerSelector, pickIdx);

        console.log(`  - Linear scale Q: "${q.title}" clicked ${numericOpts[pickIdx]} -> ${ok ? 'OK' : 'FAILED'}`);
      } else {
        console.log(`  - Scale Q fallback for "${q.title}" (no numeric options)`);
      }
      return;
    }

  if (q.type === 'radio') {
    // if scale-like, choose numeric option between min and max
    if (isScaleQuestion(q) && Array.isArray(q.options) && q.options.length) {
      // find numeric options
      const numeric = q.options.map(o => (o||'').trim()).filter(o => /^\d+$/.test(o));
      if (numeric.length) {
        const idx = randInt(0, numeric.length-1);
        return { kind: 'index', value: q.options.indexOf(numeric[idx]) }; // index of chosen numeric option
      }
    }
    // otherwise choose a random radio index
    if (Array.isArray(q.options) && q.options.length) {
      const idx = randInt(0, q.options.length-1);
      return { kind: 'index', value: idx };
    }
    return null;
  }

  if (q.type === 'checkbox') {
    if (Array.isArray(q.options) && q.options.length) {
      const c = Math.min(q.options.length, randInt(1, Math.min(2, q.options.length)));
      const shuffled = q.options.slice().sort(()=>0.5-Math.random());
      const picks = shuffled.slice(0,c).map(p => q.options.indexOf(p));
      return { kind: 'indexes', value: picks };
    }
    return null;
  }

  if (q.type === 'dropdown') {
    if (Array.isArray(q.options) && q.options.length) {
      const idx = randInt(0, q.options.length-1);
      return { kind: 'index', value: idx };
    }
    return null;
  }

  return null;
}

// fill a single parsed question
async function fillQuestion(page, q) {
  try {
    await randSleep(400, 1200);
    if (q.type === 'short_text' || q.type === 'paragraph') {
      const answer = await chooseAnswer(q, page);
      const sel = q.inputSelector || q.containerSelector || null;
      if (sel) {
        await humanType(page, sel, answer);
      } else {
        // fallback: find next available input and fill
        await page.evaluate(txt => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], textarea, input[type="email"], input[type="tel"], div[contenteditable="true"]'));
          const empty = inputs.find(i => !i.value || i.value.trim()==='');
          if (empty) { empty.focus(); empty.value = txt; empty.dispatchEvent(new Event('input',{bubbles:true})); }
        }, answer);
      }
      console.log(`  - Text Q: "${q.title}" filled -> ${String(answer).slice(0,60)}`);
      return;
    }

    if (q.type === 'radio') {
      const pick = await chooseAnswer(q, page);
      if (pick && pick.kind === 'index') {
        // click by index inside container
        const ok = await clickOptionByIndex(page, q.containerSelector, pick.value);
        await randSleep(120, 400);
        console.log(`  - Radio Q: "${q.title}" clicked option index ${pick.value} -> ${ok ? 'OK' : 'FAILED'}`);
      } else {
        // fallback try text match
        const fallback = (q.options && q.options[0]) || null;
        if (fallback) {
          await clickOptionByText(page, q.containerSelector, fallback);
        }
        console.log(`  - Radio Q fallback for "${q.title}"`);
      }
      return;
    }

    if (q.type === 'checkbox') {
      const pick = await chooseAnswer(q, page);
      if (pick && pick.kind === 'indexes') {
        for (const idx of pick.value) {
          const ok = await clickOptionByIndex(page, q.containerSelector, idx);
          await randSleep(140, 500);
          console.log(`  - Checkbox Q: "${q.title}" clicked index ${idx} -> ${ok ? 'OK' : 'FAILED'}`);
        }
      } else {
        // fallback: click first checkbox
        await clickOptionByIndex(page, q.containerSelector, 0);
        console.log(`  - Checkbox fallback for "${q.title}"`);
      }
      return;
    }

    if (q.type === 'dropdown') {
      const pick = await chooseAnswer(q, page);
      if (pick && pick.kind === 'index') {
        // try to click dropdown option by index (some dropdowns are custom)
        const ok = await clickOptionByIndex(page, q.containerSelector, pick.value);
        if (!ok && q.inputSelector) {
          // try native select
          try {
            await page.select(q.inputSelector, q.options[pick.value]);
          } catch (e) {}
        }
        console.log(`  - Dropdown Q: "${q.title}" chose index ${pick.value} -> ${ok ? 'OK' : 'FAILED'}`);
      }
      return;
    }

    if (q.type === 'date') {
      const d = new Date();
      const s = d.toISOString().slice(0,10);
      if (q.inputSelector) {
        await page.evaluate((sel,val)=>{ const el=document.querySelector(sel); if(el){ el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); } }, q.inputSelector, s);
      } else {
        await page.evaluate(val=>{ const el=document.querySelector('input[type="date"]'); if(el){ el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); } }, s);
      }
      console.log(`  - Date Q: "${q.title}" -> ${s}`);
      return;
    }

    if (q.type === 'time') {
      const t = '12:00';
      if (q.inputSelector) {
        await page.evaluate((sel,val)=>{ const el=document.querySelector(sel); if(el){ el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); } }, q.inputSelector, t);
      } else {
        await page.evaluate(val=>{ const el=document.querySelector('input[type="time"]'); if(el){ el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); } }, t);
      }
      console.log(`  - Time Q: "${q.title}" -> ${t}`);
      return;
    }

    // fallback: do nothing
    console.log(`  - Skipping unknown question type for "${q.title}"`);
  } catch (err) {
    console.warn('  ! Error filling question:', q.title, err && err.message ? err.message : err);
  }
}

async function submitOneResponse(page) {
  const questions = await parseQuestions(page);
  console.log('Parsed questions:', questions.map(q => ({ title: q.title, type: q.type, optionsCount: q.options ? q.options.length : 0 })));

  for (const q of questions) {
    await fillQuestion(page, q);
  }

  await randSleep(900, 2000);

  // click submit
  const clicked = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('div[role="button"], button, span'));
    const found = cands.find(c => c.innerText && /submit|send/i.test(c.innerText));
    if (found) { found.click(); return true; }
    return false;
  });

  if (!clicked) {
    const el = await page.$('form [type="submit"]');
    if (el) await el.click().catch(()=>{});
  }

  // wait for confirmation page to load (if any)
  await randSleep(1200, 2600);

  // click "Submit another response" if present
  await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a, div[role="button"], span, button'));
    const again = anchors.find(a => a.innerText && /submit another response|respond again|another response|submit another/i.test(a.innerText));
    if (again) again.click();
  });

  return true;
}

// main
(async () => {
  const browser = await puppeteer.launch({ headless: HEADLESS, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  for (let i = 0; i < SUBMISSIONS; i++) {
    try {
      console.log(`\n=== Submission ${i+1}/${SUBMISSIONS} ===`);
      await page.goto(FORM_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await randSleep(700, 2000);
      await submitOneResponse(page);
      console.log(`Submitted ${i+1}`);
      // longer delay before next to look human
      await randSleep(3000, 8000);
    } catch (e) {
      console.error('Submission loop error:', e && e.message ? e.message : e);
    }
  }

  await browser.close();
  console.log('All done.');
})();


