import { $, esc, toast, bindDialogs } from "./utils.js";
import { api, money } from "./api.js";
let key = "",
  products = [],
  orders = [],
  report = null,
  tab = "inventory";
const form = $("#product-form");
bindDialogs();
const request = (path, options = {}) =>
  api("/admin" + path, {
    ...options,
    headers: { Authorization: "Bearer " + key, ...options.headers },
  });
function message(error) {
  $("#admin-message").textContent = error.message;
  $("#admin-message").scrollIntoView({ block: "nearest" });
  if (error.status === 401) logout();
}
function logout() {
  key = "";
  products = [];
  orders = [];
  report = null;
  $("#dashboard").hidden = true;
  $("#login-panel").hidden = false;
  $("#logout").hidden = true;
  $("#inventory-rows").innerHTML = "";
  $("#admin-orders").innerHTML = "";
  for (const id of ["daily-sales", "top-products", "low-stock"])
    $("#" + id).innerHTML = "";
}
async function reportData() {
  const q = new URLSearchParams();
  if ($("#report-start").value) q.set("start", $("#report-start").value);
  if ($("#report-end").value) q.set("end", $("#report-end").value);
  return request("/report?" + q);
}
async function refresh() {
  const [p, o, r] = await Promise.all([
    request("/products"),
    request("/orders"),
    reportData(),
  ]);
  products = p;
  orders = o;
  report = r;
  renderInventory();
  renderOrders();
  renderReport();
  $("#admin-message").textContent = "";
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  key = e.target.elements.key.value;
  try {
    await refresh();
    $("#dashboard").hidden = false;
    $("#login-panel").hidden = true;
    $("#logout").hidden = false;
    e.target.reset();
    toast("Store desk ready");
  } catch (error) {
    key = "";
    message(error);
  } finally {
    button.disabled = false;
  }
};
$("#logout").onclick = logout;
$("#refresh-admin").onclick = async (e) => {
  e.target.disabled = true;
  try {
    await refresh();
    toast("Dashboard refreshed");
  } catch (error) {
    message(error);
  } finally {
    e.target.disabled = false;
  }
};
document.querySelectorAll("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      document
        .querySelectorAll("[data-tab]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      for (const name of ["inventory", "orders", "reports"])
        $("#" + name + "-section").hidden = name !== tab;
    }),
);
function renderInventory() {
  const q = $("#inventory-search").value.toLowerCase(),
    f = $("#inventory-filter").value,
    data = products.filter(
      (p) =>
        (p.name + " " + p.category).toLowerCase().includes(q) &&
        (f === "all" ||
          (f === "active" && p.active) ||
          (f === "archived" && !p.active) ||
          (f === "low" && p.active && p.stock <= p.low_stock)),
    );
  $("#inventory-summary").textContent =
    `${data.length} products in this view · ${products.filter((p) => p.active && p.stock <= p.low_stock).length} active products need restocking`;
  $("#inventory-rows").innerHTML = data.length
    ? data
        .map(
          (p) =>
            `<tr><td><strong>${esc(p.name)}</strong><br><small>${esc(p.category)} · ${esc(p.unit)}</small></td><td>${money(p.price)}</td><td><strong>${p.stock}</strong><br><small>Alert at ${p.low_stock}</small></td><td><span class="tag ${p.active && p.stock <= p.low_stock ? "low" : ""}">${!p.active ? "Archived" : p.stock <= p.low_stock ? "Low stock" : "Active"}</span></td><td><div class="actions"><button data-edit="${p.id}">Edit<span class="sr-only"> ${esc(p.name)}</span></button>${p.active ? `<button data-archive="${p.id}">Archive<span class="sr-only"> ${esc(p.name)}</span></button>` : ""}</div></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5">No matching products.</td></tr>';
}
$("#inventory-search").oninput = renderInventory;
$("#inventory-filter").onchange = renderInventory;
function edit(id) {
  const p = products.find((x) => x.id === id);
  form.reset();
  form.elements.id.value = p?.id || "";
  for (const name of ["name", "description", "unit"])
    form.elements[name].value = p?.[name] || "";
  form.elements.category.value = p?.category || "Produce";
  form.elements.price.value = p ? (p.price / 100).toFixed(2) : "";
  form.elements.stock.value = p?.stock ?? 0;
  form.elements.low_stock.value = p?.low_stock ?? 5;
  form.elements.icon.value = p?.icon || "bag";
  form.elements.active.value = String(p?.active ?? true);
  $("#product-error").textContent = "";
  $("#product-title").textContent = p ? "Edit product" : "Add product";
  $("#product-dialog").showModal();
  form.elements.name.focus();
}
$("#add-product").onclick = () => edit();
$("#inventory-rows").onclick = async (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.edit) edit(Number(b.dataset.edit));
  if (
    b?.dataset.archive &&
    confirm("Archive this product? Existing orders will keep their history.")
  ) {
    b.disabled = true;
    try {
      await request("/products/" + b.dataset.archive, { method: "DELETE" });
      await refresh();
      toast("Product archived");
    } catch (error) {
      message(error);
      b.disabled = false;
    }
  }
};
form.onsubmit = async (e) => {
  e.preventDefault();
  $("#save-product").disabled = true;
  const f = form.elements,
    id = f.id.value;
  try {
    const amount = f.price.value;
    if (!/^\d+(\.\d{1,2})?$/.test(amount))
      throw Error("Use up to two decimal places for price.");
    const [whole, fraction = ""] = amount.split(".");
    const body = {
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      unit: f.unit.value.trim(),
      category: f.category.value,
      price: Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
      stock: Number(f.stock.value),
      low_stock: Number(f.low_stock.value),
      icon: f.icon.value,
      active: f.active.value === "true",
    };
    await request("/products" + (id ? "/" + id : ""), {
      method: id ? "PUT" : "POST",
      body,
    });
    $("#product-dialog").close();
    await refresh();
    toast(id ? "Product updated" : "Product created");
  } catch (error) {
    $("#product-error").textContent = error.message;
  } finally {
    $("#save-product").disabled = false;
  }
};
function renderOrders() {
  const f = $("#order-filter").value,
    data = orders.filter((o) => f === "all" || o.status === f);
  $("#admin-orders").innerHTML = data.length
    ? data
        .map((o) => {
          const next = {
            pending: ["packed", "cancelled"],
            packed: ["completed", "cancelled"],
            completed: [],
            cancelled: [],
          }[o.status];
          return `<article class="panel admin-order"><div class="row between"><div><span class="tag">${esc(o.status)}</span><h3>Order ${esc(o.id.slice(0, 8).toUpperCase())}</h3><small>${esc(new Date(o.created).toLocaleString())} · ${esc(o.customer)}</small></div><strong>${money(o.total)}</strong></div><details><summary>View order & delivery details</summary><p class="order-details">${esc(o.email)}<br>${esc(o.address)}</p><ul>${o.items.map((i) => `<li>${esc(i.name)} × ${i.quantity} — ${money(i.unit_price * i.quantity)}</li>`).join("")}</ul><small>Simulated checkout. No real shipment or payment.</small></details>${next.length ? `<div class="status-tools"><select aria-label="Next status for ${esc(o.id.slice(0, 8))}">${next.map((s) => `<option value="${s}">${s}</option>`).join("")}</select><button data-status="${esc(o.id)}">Update order</button></div>` : ""}</article>`;
        })
        .join("")
    : '<p class="empty">No orders in this view.</p>';
}
$("#order-filter").onchange = renderOrders;
$("#admin-orders").onclick = async (e) => {
  const b = e.target.closest("[data-status]");
  if (!b) return;
  const status = b.parentElement.querySelector("select").value;
  if (
    status === "cancelled" &&
    !confirm("Cancel this order and return its stock?")
  )
    return;
  b.disabled = true;
  try {
    await request("/orders/" + b.dataset.status, {
      method: "PATCH",
      body: { status },
    });
    await refresh();
    toast("Order " + status);
  } catch (error) {
    message(error);
    b.disabled = false;
  }
};
function renderReport() {
  if (!report) return;
  $("#report-revenue").textContent = money(report.revenue);
  $("#report-completed").textContent = report.completed;
  $("#report-pending").textContent = report.pending;
  $("#report-counts").textContent =
    `${report.orders} orders in period · ${report.cancelled} cancelled`;
  const max = Math.max(...report.daily.map((x) => x.revenue), 1);
  $("#daily-sales").innerHTML = report.daily.length
    ? report.daily
        .map(
          (d) =>
            `<div class="report-row"><div class="row between"><span>${esc(d.date)}</span><strong>${money(d.revenue)}</strong></div><div class="report-bar" aria-hidden="true"><span style="width:${(d.revenue / max) * 100}%"></span></div></div>`,
        )
        .join("")
    : '<p class="empty">No completed sales for these dates.</p>';
  $("#top-products").innerHTML = report.top_products.length
    ? report.top_products
        .map(
          (p) =>
            `<div class="report-row row between"><div><strong>${esc(p.name)}</strong><br><small>${p.quantity} units sold</small></div><span>${money(p.revenue)}</span></div>`,
        )
        .join("")
    : '<p class="empty">Your best sellers will appear here.</p>';
  $("#low-stock").innerHTML = report.low_stock.length
    ? report.low_stock
        .map(
          (p) =>
            `<div class="report-row row between"><strong>${esc(p.name)}</strong><span class="tag low">${p.stock} left / alert at ${p.low_stock}</span></div>`,
        )
        .join("")
    : "<p>All active products are above their stock thresholds.</p>";
}
$("#report-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    report = await reportData();
    renderReport();
    $("#admin-message").textContent = "";
  } catch (error) {
    message(error);
  }
};
$("#report-reset").onclick = () => {
  $("#report-start").value = "";
  $("#report-end").value = "";
  $("#report-form").requestSubmit();
};
