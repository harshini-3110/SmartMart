const fs = require("node:fs");
fs.mkdirSync("test-results", { recursive: true });
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL
      ? { channel: process.env.BROWSER_CHANNEL }
      : {}),
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("dialog", (d) => d.accept());
    await page.goto(process.env.BASE_URL || "http://127.0.0.1:8000/");
    await page
      .getByText("Orders saved in this browser.", { exact: true })
      .waitFor({ state: "attached" });
    if (
      (await page.locator(".topline").count()) ||
      (await page.getByRole("button", { name: "Export receipt access" }).count())
    )
      throw Error("removed storefront UI is still present");
    await page
      .getByRole("button", {
        name: "Add Orchard apples to basket",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Basket 1", exact: true }).click();
    await page
      .getByRole("button", { name: "Increase Orchard apples", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Continue to simulated checkout →",
        exact: true,
      })
      .click();
    await page
      .getByText(
        "This is a simulated order. No payment will be collected and nothing will be shipped. Use fictional details.",
        { exact: true },
      )
      .waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Browser Tester");
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser@example.test");
    await page
      .getByLabel("Delivery address", { exact: true })
      .fill("123 Fictional Demo Street");
    await page
      .getByRole("button", { name: "Place demo order", exact: true })
      .click();
    await page.locator("#customer-orders .receipt").waitFor();
    await page
      .getByText("Order confirmed. No payment was collected.", { exact: true })
      .waitFor();
    const receipt = await page.evaluate(
      () => JSON.parse(localStorage.getItem("smartmart.receipts.v1"))[0],
    );
    await page
      .getByRole("button", { name: "Close orders", exact: true })
      .click();
    await page.reload();
    await page.getByRole("button", { name: "My orders", exact: true }).click();
    await page.locator("#customer-orders .receipt").waitFor();
    await page
      .getByRole("button", { name: "Close orders", exact: true })
      .click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({
      path: "test-results/smartmart-shop.png",
      fullPage: true,
    });
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )
      )
        throw Error(`shop horizontal overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/smartmart-mobile.png",
      fullPage: true,
    });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error("shop mobile overflow");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      new URL("admin.html", process.env.BASE_URL || "http://127.0.0.1:8000/")
        .href,
    );
    if (
      (await page.locator(".topline").count()) ||
      (await page.getByText("Local demo key: smartmart-local-demo").count()) ||
      (await page.getByText("Set a unique key before deploying.").count()) ||
      (await page
        .getByText("Enter the admin access key configured on your backend.")
        .count())
    )
      throw Error("removed admin UI is still present");
    await page.getByRole("heading", { name: "Open your store desk" }).waitFor();
    await page.getByLabel("Admin access key", { exact: true }).waitFor();
    if ((await page.getByText("admindash", { exact: false }).count()) !== 0)
      throw Error("admin page exposes the demo access key");
    await page.getByLabel("Admin access key", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByText("Admin access key required", { exact: true })
      .waitFor();
    if (errors.some((error) => !error.includes("401 (Unauthorized)")))
      throw Error(errors.join("\n"));
    errors.length = 0;
    await page
      .getByLabel("Admin access key", { exact: true })
      .fill(process.env.SMARTMART_ADMIN_KEY || "admindash");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("button", { name: "+ Add product", exact: true })
      .click();
    await page
      .getByLabel("Product name", { exact: true })
      .fill("Browser test granola");
    await page
      .getByLabel("Description", { exact: true })
      .fill("A test-only pantry product.");
    await page.getByLabel("Unit / pack size", { exact: true }).fill("250 g");
    await page.getByLabel("Price (INR)", { exact: true }).fill("99.50");
    await page.getByLabel("Stock units", { exact: true }).fill("5");
    await page
      .getByRole("button", { name: "Save product", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Browser test granola", exact: true })
      .click();
    await page.getByLabel("Stock units", { exact: true }).fill("7");
    await page
      .getByRole("button", { name: "Save product", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Archive Browser test granola",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Orders", exact: true }).click();
    const card = page
      .locator(".admin-order")
      .filter({ hasText: receipt.id.slice(0, 8).toUpperCase() });
    await card.getByRole("button", { name: "Update order" }).click();
    await card.getByText("packed", { exact: true }).waitFor();
    await card.locator("select").selectOption("completed");
    await card.getByRole("button", { name: "Update order" }).click();
    await card.getByText("completed", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Sales reports", exact: true })
      .click();
    await page.locator("#low-stock .report-row").first().waitFor();
    await page.screenshot({
      path: "test-results/smartmart-admin.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/smartmart-admin-mobile.png",
      fullPage: true,
    });
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )
      )
        throw Error(`admin horizontal overflow at ${width}px`);
    }
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    if (errors.length) throw Error(errors.join("\n"));
    console.log(
      "SmartMart browser: basket, checkout, receipt persistence, admin auth, product CRUD/archive, fulfillment, reports, 390/768/1280px layouts and console checks passed",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
