/* MCC ReLoop admin page. Deleting a listing is handled by a protected Edge Function. */
(() => {
  const db = window.reloop.db;
  const $ = (selector) => document.querySelector(selector);
  let currentUser = null;
  let isChecking = false;
  let items = [];
  let toastTimer = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function showMessage(selector, message) {
    $(selector).textContent = message || "";
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function showLogin(message = "") {
    $("#admin-login").hidden = false;
    $("#admin-dashboard").hidden = true;
    showMessage("#admin-login-message", message);
  }

  async function signIn() {
    showMessage("#admin-login-message", "Opening Google sign-in…");
    const { error } = await db.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.reloop.getRedirectUrl(),
        queryParams: { hd: "mcc.edu.in", prompt: "select_account" }
      }
    });
    if (error) showMessage("#admin-login-message", error.message);
  }

  async function checkAccess(user) {
    if (!user) {
      currentUser = null;
      showLogin();
      return;
    }
    if (!user.email || !user.email.toLowerCase().endsWith("@mcc.edu.in")) {
      currentUser = null;
      showLogin("Please sign in with a verified @mcc.edu.in Google account.");
      await db.auth.signOut();
      return;
    }
    if (isChecking) return;
    isChecking = true;
    currentUser = user;
    showMessage("#admin-login-message", "Checking administrator access…");
    const { data: allowed, error } = await db.rpc("is_reloop_admin");
    isChecking = false;
    if (error || allowed !== true) {
      currentUser = null;
      showLogin("This MCC account is not approved for administrator access.");
      return;
    }
    $("#admin-login").hidden = true;
    $("#admin-dashboard").hidden = false;
    await loadItems();
  }

  function imageUrl(path) {
    if (!path) return "./images/reloop-logo-transparent.png";
    return db.storage.from("item-images").getPublicUrl(path).data.publicUrl;
  }

  async function loadItems() {
    $("#admin-list").innerHTML = '<p class="muted">Loading listings…</p>';
    const { data, error } = await db.from("items")
      .select("id,title,category,description,item_condition,purpose,location,image_path,status,created_at,owner_id")
      .order("created_at", { ascending: false });
    if (error) {
      $("#admin-list").innerHTML = '<p class="muted">Could not load listings. Please refresh the page.</p>';
      showMessage("#admin-action-message", error.message);
      return;
    }
    items = data || [];
    renderItems();
  }

  function renderItems() {
    const query = $("#admin-search").value.trim().toLowerCase();
    const status = $("#admin-status-filter").value;
    const shown = items.filter((item) => {
      const text = `${item.title} ${item.category} ${item.description} ${item.location}`.toLowerCase();
      return (status === "all" || item.status === status) && text.includes(query);
    });
    $("#total-count").textContent = String(items.length);
    $("#available-count").textContent = String(items.filter((item) => item.status === "available").length);
    $("#unavailable-count").textContent = String(items.filter((item) => item.status === "unavailable").length);
    if (!shown.length) {
      $("#admin-list").innerHTML = '<p class="muted">No listings match this filter.</p>';
      return;
    }
    $("#admin-list").innerHTML = shown.map((item) => `
      <article class="admin-item">
        <img src="${escapeHtml(imageUrl(item.image_path))}" alt="" loading="lazy">
        <div><h3>${escapeHtml(item.title)}</h3><p class="meta">${escapeHtml(item.category)} · ${escapeHtml(item.location)} · ${escapeHtml(new Date(item.created_at).toLocaleDateString())}</p><span class="status ${item.status === "unavailable" ? "unavailable" : ""}">${escapeHtml(item.status)}</span></div>
        <div class="admin-item-actions"><button class="small-action" data-toggle-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">${item.status === "available" ? "Mark unavailable" : "Make available"}</button><button class="small-action danger" data-delete-id="${escapeHtml(item.id)}">Delete listing</button></div>
      </article>`).join("");

    document.querySelectorAll("[data-toggle-id]").forEach((button) => button.addEventListener("click", () => toggleStatus(button.dataset.toggleId, button.dataset.status)));
    document.querySelectorAll("[data-delete-id]").forEach((button) => button.addEventListener("click", () => deleteItem(button.dataset.deleteId)));
  }

  async function toggleStatus(id, currentStatus) {
    showMessage("#admin-action-message", "");
    const nextStatus = currentStatus === "available" ? "unavailable" : "available";
    const { error } = await db.from("items").update({ status: nextStatus }).eq("id", id);
    if (error) {
      showMessage("#admin-action-message", error.message || "Could not update listing status.");
      return;
    }
    showToast("Listing status updated.");
    await loadItems();
  }

  async function deleteItem(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    const confirmed = window.confirm(`Permanently delete “${item.title}”? Its image, conversations and messages will also be removed.`);
    if (!confirmed) return;
    showMessage("#admin-action-message", "Deleting listing and cleaning up its image…");
    const buttons = [...document.querySelectorAll("[data-delete-id]")].filter((button) => button.dataset.deleteId === id);
    buttons.forEach((button) => { button.disabled = true; });
    const { data, error } = await db.functions.invoke("admin-delete-item", { body: { action: "delete-item", itemId: id } });
    if (error || !data?.success) {
      showMessage("#admin-action-message", error?.message || data?.error || "The listing could not be deleted.");
      buttons.forEach((button) => { button.disabled = false; });
      return;
    }
    await loadItems();
    if (data.cleanupPending > 0) {
      showMessage("#admin-action-message", "The listing and its chats were deleted. Image cleanup is still pending; tap “Retry image cleanup”.");
    } else {
      showMessage("#admin-action-message", "Listing, image and related chats deleted successfully.");
    }
  }

  async function retryCleanup() {
    const button = $("#retry-cleanup-button");
    button.disabled = true;
    showMessage("#admin-action-message", "Retrying pending image cleanup…");
    const { data, error } = await db.functions.invoke("admin-delete-item", { body: { action: "retry-cleanup" } });
    button.disabled = false;
    if (error || !data?.success) {
      showMessage("#admin-action-message", error?.message || data?.error || "Image cleanup could not be completed.");
      return;
    }
    if (data.cleanupPending > 0) showMessage("#admin-action-message", `${data.cleanupPending} image cleanup task(s) remain pending. You can try again later.`);
    else showMessage("#admin-action-message", "All pending image cleanup tasks are complete.");
  }

  async function signOut() {
    await db.auth.signOut();
    currentUser = null;
    showLogin("You have signed out.");
  }

  $("#admin-signin-button").addEventListener("click", signIn);
  $("#admin-signout-button").addEventListener("click", signOut);
  $("#retry-cleanup-button").addEventListener("click", retryCleanup);
  $("#admin-search").addEventListener("input", renderItems);
  $("#admin-status-filter").addEventListener("change", renderItems);

  db.auth.onAuthStateChange((_event, session) => {
    checkAccess(session?.user || null);
  });
  db.auth.getSession().then(({ data }) => checkAccess(data.session?.user || null));
})();
