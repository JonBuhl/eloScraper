/**
 * OTH Moodle PDF Scraper
 * Authentifizierung via Shibboleth/SSO
 * Struktur: <OUTPUT_DIR>/<Kursname>/<Abschnitt>/<datei.pdf>
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from "fs";
import { join, resolve, extname } from "path";
import { config } from "dotenv";
import https from "https";
import http from "http";
import { createWriteStream } from "fs";

config();

// ─── Konfiguration ────────────────────────────────────────────────────────────

const MOODLE_BASE   = "https://elearning.oth-regensburg.de";
const SSO_LOGIN_URL = `${MOODLE_BASE}/auth/shibboleth/index.php`;
const OUTPUT_DIR    = resolve(process.env.OUTPUT_DIR || "./downloads");
const HEADLESS      = process.env.HEADLESS !== "false";
const COOKIES_FILE  = resolve("./.session-cookies.json");
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip,.txt")
  .split(",")
  .map(ext => ext.trim().toLowerCase())
  .filter(Boolean)
  .map(ext => ext.startsWith(".") ? ext : `.${ext}`);

let rawCourses = process.argv.slice(2);
if (rawCourses.length === 0 && process.env.COURSE_IDS) {
  rawCourses = process.env.COURSE_IDS.split(",").map(c => c.trim()).filter(Boolean);
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extractCourseId(input) {
  const match = input.match(/id=(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

// ─── Session speichern / laden ────────────────────────────────────────────────

function saveCookies(cookies) {
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  log("💾", "Session gespeichert.");
}

function loadCookies() {
  if (!existsSync(COOKIES_FILE)) return null;
  try {
    return JSON.parse(readFileSync(COOKIES_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Login via Shibboleth ─────────────────────────────────────────────────────

async function shibbolethLogin(page) {
  log("🔐", "Starte SSO-Login …");
  await page.goto(SSO_LOGIN_URL, { waitUntil: "networkidle" });

  const user = process.env.OTH_USER;
  const pass = process.env.OTH_PASS;
  if (!user || !pass) throw new Error("OTH_USER und OTH_PASS müssen in der .env-Datei gesetzt sein.");

  await page.waitForSelector('input[type="text"], input[name="j_username"]', { timeout: 15000 });
  await page.locator('input[name="j_username"], input[name="username"], input[type="text"]').first().fill(user);
  await page.locator('input[name="j_password"], input[name="password"], input[type="password"]').first().fill(pass);
  await page.locator('input[type="password"]').first().press("Enter");
  await page.waitForURL(`${MOODLE_BASE}/**`, { timeout: 20000 });
  log("✅", "Login erfolgreich.");
}

// ─── Kurs scrapen ─────────────────────────────────────────────────────────────

async function scrapeCourse(page, courseId) {
  const courseUrl = `${MOODLE_BASE}/course/view.php?id=${courseId}`;
  log("📚", `Lade Kurs ${courseId} …`);
  await page.goto(courseUrl, { waitUntil: "networkidle" });

  const courseName = sanitize(
    await page
      .locator(".page-header-headings h1, h1.h2, #page-header h1")
      .first()
      .innerText()
      .catch(() => `Kurs_${courseId}`)
  );
  log("📖", `Kursname: "${courseName}"`);

  const sections = await page.locator('li[id^="section-"], div[id^="section-"]').all();
  log("🗂 ", `${sections.length} Abschnitt(e) gefunden.`);

  const results = { course: courseName, sections: [] };

  for (const section of sections) {
    let sectionName = await section
      .locator(".sectionname, .section-title h3, h3.sectionname, .content > h3")
      .first()
      .innerText()
      .catch(() => "Allgemein");
    sectionName = sanitize(sectionName) || "Allgemein";

    const seenHrefs = new Set();
    const files = [];

    // Direkte pluginfile.php-Links
    for (const link of await section.locator('a[href*="pluginfile.php"]').all()) {
      const href = await link.getAttribute("href");
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      let label = sanitize(await link.innerText().catch(() => "")) ||
        decodeURIComponent(href.split("/").pop().replace(/\?.*$/, ""));
      
      for (const ext of ALLOWED_EXTENSIONS) {
        if (label.toLowerCase().endsWith(ext)) {
          label = label.slice(0, -ext.length);
          break;
        }
      }
      files.push({ href, label, indirect: false });
    }

    // mod/resource-Links → lösen Browser-Download aus
    for (const link of await section.locator('a[href*="mod/resource/view.php"]').all()) {
      const href = await link.getAttribute("href");
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      const label = sanitize(await link.innerText().catch(() => "Dokument"));
      files.push({ href, label, indirect: true });
    }

    if (files.length > 0) {
      results.sections.push({ name: sectionName, files });
    }
  }

  return results;
}

// ─── Download via Playwright Download-Event (mod/resource) ───────────────────

async function downloadViaPlaywright(context, url, destDir, preferredName) {
  const dlPage = await context.newPage();
  try {
    const [download] = await Promise.all([
      dlPage.waitForEvent("download", { timeout: 30000 }),
      dlPage.goto(url).catch(e => {
        if (!e.message.includes("Download is starting") && !e.message.includes("net::ERR_ABORTED")) {
          throw e;
        }
      }),
    ]);

    const suggestedName = download.suggestedFilename();
    const ext = extname(suggestedName).toLowerCase();

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      await download.cancel();
      throw new Error(`Nicht erlaubt (Endung: "${ext || "keine"}")`);
    }

    // Dateiname: Moodles suggestedName hat Vorrang (enthält den echten Namen)
    const finalName = sanitize(suggestedName);
    const finalPath = join(destDir, finalName);

    if (existsSync(finalPath)) {
      await download.cancel();
      log("⏭ ", `Übersprungen (vorhanden): ${finalName}`);
      return { skipped: true };
    }

    const tmpPath = await download.path();
    if (!tmpPath) throw new Error("Kein temp-Pfad vom Download.");
    copyFileSync(tmpPath, finalPath);
    return { skipped: false, name: finalName };
  } finally {
    await dlPage.close();
  }
}

// ─── Download via HTTP + Cookies (pluginfile.php) ────────────────────────────

async function downloadViaCookies(context, url, destPath) {
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  return new Promise((resolve, reject) => {
    function doGet(targetUrl) {
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === "https:" ? https : http;
      lib.get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { Cookie: cookieHeader },
        },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return doGet(res.headers.location);
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          
          const stream = createWriteStream(destPath);
          res.pipe(stream);
          stream.on("finish", resolve);
          stream.on("error", reject);
        }
      ).on("error", reject);
    }
    doGet(url);
  });
}

// ─── Dateien herunterladen ───────────────────────────────────────────────────────

async function downloadFiles(context, page, courseData) {
  const courseDir = join(OUTPUT_DIR, courseData.course);
  mkdirSync(courseDir, { recursive: true });

  let total = 0, skipped = 0, failed = 0;

  for (const section of courseData.sections) {
    const sectionDir = join(courseDir, section.name);
    mkdirSync(sectionDir, { recursive: true });

    for (const file of section.files) {
      if (file.indirect) {
        // mod/resource: Browser-Download abfangen, Moodle wählt den Dateinamen
        log("⬇️ ", `[resource] ${section.name}/${file.label}`);
        try {
          const result = await downloadViaPlaywright(context, file.href, sectionDir, file.label);
          if (result.skipped) {
            skipped++;
          } else {
            log("  ✅", result.name);
            total++;
          }
        } catch (e) {
          log("❌", `"${file.label}": ${e.message}`);
          failed++;
        }
      } else {
        // pluginfile.php: direkt über HTTP
        let fileName = file.label;
        const linkPath = new URL(file.href).pathname.replace(/\?.*$/, "");
        const linkExt = extname(linkPath).toLowerCase();

        if (!ALLOWED_EXTENSIONS.some(e => fileName.toLowerCase().endsWith(e))) {
          if (ALLOWED_EXTENSIONS.includes(linkExt)) {
            fileName += linkExt;
          } else {
            fileName += ".pdf"; // Fallback
          }
        }
        
        const destPath = join(sectionDir, fileName);

        if (existsSync(destPath)) {
          log("⏭ ", `Übersprungen (vorhanden): ${section.name}/${fileName}`);
          skipped++;
          continue;
        }

        log("⬇️ ", `[direct] ${section.name}/${fileName}`);
        try {
          await downloadViaCookies(context, file.href, destPath);
          total++;
        } catch (e) {
          log("❌", `"${fileName}": ${e.message}`);
          failed++;
        }
      }
    }
  }

  return { total, skipped, failed };
}

// ─── Hauptprogramm ────────────────────────────────────────────────────────────

async function main() {
  if (rawCourses.length === 0) {
    console.error(
      "\nUsage: node scraper.mjs <kurs-id-oder-url> [weitere ...]\n" +
      "Oder via .env-Datei: COURSE_IDS=7969,8017\n" +
      "Beispiele:\n" +
      "  node scraper.mjs 7969\n" +
      '  node scraper.mjs "https://elearning.oth-regensburg.de/course/view.php?id=7969"\n' +
      "  node scraper.mjs 7969 1234 5678\n"
    );
    process.exit(1);
  }

  const courseIds = rawCourses.map(extractCourseId).filter(Boolean);
  if (courseIds.length === 0) {
    console.error("❌  Keine gültigen Kurs-IDs gefunden.");
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  // acceptDownloads: true → Pflicht damit Playwright Download-Events feuert
  const context = await browser.newContext({ acceptDownloads: true });

  const savedCookies = loadCookies();
  if (savedCookies) {
    await context.addCookies(savedCookies);
    log("🍪", "Gespeicherte Session geladen.");
  }

  const page = await context.newPage();
  await page.goto(`${MOODLE_BASE}/my/`, { waitUntil: "networkidle" });

  const isLoggedIn = await page
    .locator('[data-key="home"], .usermenu')
    .first()
    .isVisible()
    .catch(() => false);

  if (!isLoggedIn) {
    await shibbolethLogin(page);
    saveCookies(await context.cookies());
  }

  for (const courseId of courseIds) {
    try {
      const courseData = await scrapeCourse(page, courseId);
      const { total, skipped, failed } = await downloadFiles(context, page, courseData);
      log(
        "🎉",
        `Kurs "${courseData.course}" fertig – ` +
        `${total} heruntergeladen, ${skipped} übersprungen, ${failed} fehlgeschlagen.`
      );
    } catch (e) {
      log("❌", `Fehler bei Kurs ${courseId}: ${e.message}`);
    }
  }

  await browser.close();
  log("✅", `Alle Kurse verarbeitet. Dateien in: ${OUTPUT_DIR}`);
}

main().catch((e) => {
  console.error("Fataler Fehler:", e);
  process.exit(1);
});
