import { $, esc, toast, load, save, bindDialogs } from "./utils.js";
import { api, money, art } from "./api.js";
const CART = "smartmart.cart.v1",
  RECEIPTS = "smartmart.receipts.v1";
let products = [],
  cart = load(
    CART,
    () => [],
    (d) =>
      Array.isArray(d) &&
      d.length <= 100 &&
      d.every(
        (x) =>
          Number.isInteger(x.id) &&
          Number.isInteger(x.quantity) &&
          x.quantity > 0 &&
          x.quantity <= 99 &&
          typeof x.name === "string" &&
          Number.isInteger(x.price) &&
          x.price > 0,
      ),
  ),
  receipts = load(
    RECEIPTS,
    () => [],
    (d) =>
      Array.isArray(d) &&
      d.length <= 100 &&
      d.every((x) => typeof x.id === "string" && typeof x.token === "string"),
  ),
  busy = false;
bindDialogs();
function count() {
  $("#cart-count").textContent = cart.reduce((s, x) => s + x.quantity, 0);
}
function total() {
  return cart.reduce((s, x) => s + x.quantity * x.price, 0);
}
function persist() {
  save(CART, cart);
  count();
}
function render() {
  let visible = products.filter(
    (p) =>
      (p.name + " " + p.description)
        .toLowerCase()
        .includes($("#search").value.toLowerCase()) &&
      (!$("#category").value || p.category === $("#category").value),
  );
  const sort = $("#sort").value;
  visible.sort((a, b) =>
    sort === "low"
      ? a.price - b.price
      : sort === "high"
        ? b.price - a.price
        : sort === "name"
          ? a.name.localeCompare(b.name)
          : a.id - b.id,
  );
  $("#product-count").textContent = `${visible.length} fresh finds`;
  $("#products").innerHTML = visible.length
    ? visible
        .map(
          (p, i) =>
            `<article class="product" style="animation-delay:${Math.min(i, 8) * 35}ms"><div class="product-art" data-category="${esc(p.category)}">${art(p.icon)}${!p.stock ? '<span class="tag">Back soon</span>' : p.stock <= p.low_stock ? '<span class="tag">Last few</span>' : ""}</div><div class="product-body"><small>${esc(p.category)} · ${esc(p.unit)}</small><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="row between"><strong>${money(p.price)}</strong><button data-add="${p.id}" ${p.stock ? "" : "disabled"} aria-label="Add ${esc(p.name)} to basket">${p.stock ? "+ Add" : "Sold out"}</button></div></div></article>`,
        )
        .join("")
    : '<div class="empty"><strong>No matches on these shelves.</strong>Try another search or category.</div>';
}
async function refresh() {
  $("#refresh").disabled = true;
  try {
    products = await api("/products");
    $("#shop-error").textContent = "";
    render();
    return true;
  } catch (e) {
    $("#shop-error").textContent = e.message;
    $("#products").innerHTML =
      '<p class="empty">The shelves are unavailable. Use Refresh shelves to retry.</p>';
  } finally {
    $("#refresh").disabled = false;
  }
}
$("#products").onclick = (e) => {
  const b = e.target.closest("[data-add]");
  if (!b) return;
  const p = products.find((x) => x.id === Number(b.dataset.add)),
    line = cart.find((x) => x.id === p.id);
  if ((line?.quantity || 0) >= Math.min(p.stock, 99)) {
    toast("That is all the available stock.");
    return;
  }
  if (line) {
    line.quantity++;
    line.price = p.price;
  } else cart.push({ id: p.id, name: p.name, price: p.price, quantity: 1 });
  persist();
  toast(p.name + " added");
};
function renderCart() {
  $("#cart-items").innerHTML = cart.length
    ? cart
        .map(
          (x) =>
            `<div class="cart-line"><div class="row between"><strong>${esc(x.name)}</strong><span>${money(x.price * x.quantity)}</span></div><small>${money(x.price)} each</small><div class="quantity"><button data-minus="${x.id}" aria-label="Decrease ${esc(x.name)}">−</button><span aria-label="Quantity">${x.quantity}</span><button data-plus="${x.id}" aria-label="Increase ${esc(x.name)}">+</button><button data-remove="${x.id}">Remove<span class="sr-only"> ${esc(x.name)}</span></button></div></div>`,
        )
        .join("")
    : '<p class="empty">Your basket is waiting for something good.</p>';
  $("#cart-total").textContent = money(total());
  $("#to-checkout").disabled = !cart.length;
}
$("#open-cart").onclick = () => {
  renderCart();
  $("#cart-dialog").showModal();
};
$("#cart-items").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const id = Number(b.dataset.minus || b.dataset.plus || b.dataset.remove),
    line = cart.find((x) => x.id === id);
  if (b.dataset.remove) cart = cart.filter((x) => x.id !== id);
  else if (b.dataset.minus) {
    line.quantity--;
    cart = cart.filter((x) => x.quantity > 0);
  } else {
    const p = products.find((x) => x.id === id);
    if (!p || line.quantity >= Math.min(p.stock, 99)) {
      toast("No more stock available.");
      return;
    }
    line.quantity++;
  }
  persist();
  renderCart();
};
$("#to-checkout").onclick = async () => {
  if (!(await refresh())) {
    toast("Connect to the store before checking out.");
    return;
  }
  const removed = cart.filter(
    (x) => !products.some((p) => p.id === x.id && p.stock > 0),
  );
  let changed = !!removed.length;
  cart = cart
    .filter((x) => !removed.includes(x))
    .map((x) => {
      const p = products.find((p) => p.id === x.id);
      if (x.price !== p.price || x.quantity > p.stock) changed = true;
      return {
        ...x,
        name: p.name,
        price: p.price,
        quantity: Math.min(x.quantity, p.stock),
      };
    });
  persist();
  renderCart();
  if (changed) {
    toast("Stock or prices changed. Please review your updated basket.");
    return;
  }
  if (!cart.length) return;
  $("#cart-dialog").close();
  $("#checkout-total").textContent = `Order total: ${money(total())}`;
  $("#checkout-error").textContent = "";
  $("#checkout-dialog").showModal();
};
$("#checkout-form").onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  const f = e.target.elements,
    body = {
      customer: f.customer.value.trim(),
      email: f.email.value.trim(),
      address: f.address.value.trim(),
      items: cart.map((x) => ({
        product_id: x.id,
        quantity: x.quantity,
        unit_price: x.price,
      })),
    };
  let attempt;
  try {
    attempt = JSON.parse(
      sessionStorage.getItem("smartmart.checkout") || "null",
    );
  } catch {}
  if (!attempt || JSON.stringify(attempt.body) !== JSON.stringify(body))
    attempt = { key: crypto.randomUUID(), body };
  try {
    sessionStorage.setItem("smartmart.checkout", JSON.stringify(attempt));
  } catch {}
  busy = true;
  $("#place-order").disabled = true;
  $("#place-order").textContent = "Placing your order…";
  try {
    const order = await api("/orders", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": attempt.key },
    });
    receipts = [
      { id: order.id, token: order.token },
      ...receipts.filter((x) => x.id !== order.id),
    ].slice(0, 100);
    save(RECEIPTS, receipts);
    cart = [];
    persist();
    try {
      sessionStorage.removeItem("smartmart.checkout");
    } catch {}
    $("#checkout-dialog").close();
    e.target.reset();
    toast("Order confirmed. No payment was collected.");
    await refresh();
    await showOrders();
  } catch (error) {
    $("#checkout-error").textContent =
      error.message +
      (error.status === 409
        ? " Close checkout and review your basket."
        : " Retry with the same details to avoid duplicate orders.");
  } finally {
    busy = false;
    $("#place-order").disabled = false;
    $("#place-order").textContent = "Place demo order";
  }
};
async function showOrders() {
  if (!$("#orders-dialog").open) $("#orders-dialog").showModal();
  $("#customer-orders").innerHTML = "<p>Loading receipts…</p>";
  const result = await Promise.all(
    receipts.map(async (r) => {
      try {
        const o = await api("/orders/" + encodeURIComponent(r.id), {
          headers: { "X-Order-Token": r.token },
        });
        return `<article class="receipt"><span class="tag">${esc(o.status)}</span><h3>Order ${esc(o.id.slice(0, 8).toUpperCase())}</h3><small>${esc(new Date(o.created).toLocaleString())}</small><ul>${o.items.map((i) => `<li>${esc(i.name)} × ${i.quantity} — ${money(i.unit_price * i.quantity)}</li>`).join("")}</ul><strong>${money(o.total)}</strong><p class="muted">Simulated checkout · No charge</p></article>`;
      } catch (e) {
        return `<p class="notice">Order ${esc(r.id.slice(0, 8))}: ${esc(e.message)}</p>`;
      }
    }),
  );
  $("#customer-orders").innerHTML =
    result.join("") ||
    '<p class="empty">No orders saved in this browser yet.</p>';
}
$("#my-orders").onclick = showOrders;
$("#refresh").onclick = refresh;
for (const id of ["search", "category", "sort"]) $("#" + id).oninput = render;
try {
  const pending = JSON.parse(
    sessionStorage.getItem("smartmart.checkout") || "null",
  );
  if (pending?.body) {
    for (const name of ["customer", "email", "address"])
      $("#checkout-form").elements[name].value = pending.body[name] || "";
  }
} catch {}
count();
refresh();
