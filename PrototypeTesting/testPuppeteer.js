const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    headless: false, // change to true if you want hidden browser
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();
  await page.goto("https://www.google.com");
  console.log("✅ Puppeteer launched successfully!");

  await new Promise(r => setTimeout(r, 3000));
  await browser.close();
})();
