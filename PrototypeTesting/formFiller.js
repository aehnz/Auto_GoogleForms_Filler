const puppeteer = require("puppeteer");
const { faker } = require("@faker-js/faker");

// 🔹 Replace this with your Google Form link
const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSf9mxZCQJCD5p6RH9XmidiAX5NOBykbTpAlYwY9Lrx3mlIpmg/viewform?usp=dialog"; 

(async () => {
  const browser = await puppeteer.launch({
    headless: false, // shows browser for testing
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(FORM_URL, { waitUntil: "networkidle2" });

  console.log("🧠 Loaded Google Form...");

  // Small delay like a human reading
  await new Promise(r => setTimeout(r, 2000));

  // Example: fill first short answer field
  const fakeName = faker.person.fullName();
  await page.type("input[type='text']", fakeName, { delay: 100 }); // human typing delay

  console.log(`🖊️ Entered name: ${fakeName}`);

  // Wait 2s before closing
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
