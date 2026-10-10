/* MCC ReLoop: public listing page, Google sign-in and private chats. */
(() => {
  const db = window.reloop.db;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  let currentUser = null;
  let items = [];
  let activeConversationId = null;
  let activeChannel = null;
  let inboxItems = [];
  let toastTimer = null;

  const signinDialog = $("#signin-dialog");
  const listingDialog = $("#listing-dialog");
  const messagesDialog = $("#messages-dialog");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function showFormMessage(selector, message) {
    $(selector).textContent = message || "";
  }

  function isMccEmail(email) {
    return typeof email === "string" && email.toLowerCase().endsWith("@mcc.edu.in");
  }

  function setAccountUI() {
    const accountButton = $("#account-button");
    const chatsButton = $("#my-chats-button");
    if (currentUser) {
      accountButton.textContent = currentUser.email || "Sign out";
      accountButton.title = "Sign out of " + (currentUser.email || "MCC ReLoop");
      accountButton.classList.add("account-email");
      chatsButton.hidden = false;
    } else {
      accountButton.textContent = "Sign in";
      accountButton.title = "Sign in with an MCC Google account";
      accountButton.classList.remove("account-email");
      chatsButton.hidden = true;
    }
  }

  function openSignIn(message = "") {
    showFormMessage("#signin-message", message);
    if (!signinDialog.open) signinDialog.showModal();
  }

  function savePendingAction(action, value = "") {
    sessionStorage.setItem("reloop-pending-action", JSON.stringify({ action, value }));
  }

  function requireMember(action, value = "") {
    if (currentUser && isMccEmail(currentUser.email)) return true;
    savePendingAction(action, value);
    openSignIn();
    return false;
  }

  async function runPendingAction() {
    if (!currentUser) return;
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem("reloop-pending-action") || "null"); }
    catch { pending = null; }
    sessionStorage.removeItem("reloop-pending-action");
    if (!pending) return;
    setTimeout(() => {
      if (!currentUser) return;
      if (pending.action === "list") openListingDialog();
      if (pending.action === "chat") startChat(pending.value);
      if (pending.action === "inbox") openInbox();
    }, 250);
  }

  async function signInWithGoogle() {
    showFormMessage("#signin-message", "Opening Google sign-in…");
    const { error } = await db.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.reloop.getRedirectUrl(),
        queryParams: { hd: "mcc.edu.in", prompt: "select_account" }
      }
    });
    if (error) showFormMessage("#signin-message", error.message);
  }

  async function handleSession(session) {
    const nextUser = session?.user || null;
    if (nextUser && !isMccEmail(nextUser.email)) {
      currentUser = null;
      setAccountUI();
      await db.auth.signOut();
      openSignIn("Please use a verified Google account ending in @mcc.edu.in.");
      return;
    }
    currentUser = nextUser;
    setAccountUI();
    await loadItems();
    if (currentUser) await runPendingAction();
  }

  function itemImageUrl(path) {
    if (!path) return "./images/reloop-logo-transparent.png";
    return db.storage.from("item-images").getPublicUrl(path).data.publicUrl;
  }

  async function loadItems() {
    const grid = $("#item-grid");
    grid.innerHTML = '<div class="loading-card">Loading ReLoop items…</div>';
    const { data, error } = await db.from("items")
      .select("id,owner_id,title,category,description,item_condition,purpose,location,image_path,status,created_at")
      .eq("status", "available")
      .order("created_at", { ascending: false });

    if (error) {
      grid.innerHTML = '<div class="loading-card">Listings could not be loaded. Please refresh the page.</div>';
      $("#result-count").textContent = "Unable to load listings";
      console.error("ReLoop listing load failed:", error.message);
      return;
    }
    items = data || [];
    renderItems();
  }

  function renderItems() {
    const query = $("#search-input").value.trim().toLowerCase();
    const category = $("#category-filter").value;
    const shown = items.filter((item) => {
      const matchesCategory = category === "all" || item.category === category;
      const searchable = `${item.title} ${item.description} ${item.location} ${item.category}`.toLowerCase();
      return matchesCategory && searchable.includes(query);
    });

    $("#result-count").textContent = `${shown.length} ${shown.length === 1 ? "listing" : "listings"}`;
    $("#empty-state").hidden = shown.length > 0;
    if (!shown.length) {
      $("#item-grid").innerHTML = "";
      return;
    }

    $("#item-grid").innerHTML = shown.map((item) => `
      <article class="item-card">
        <img class="item-image" src="${escapeHtml(itemImageUrl(item.image_path))}" alt="${escapeHtml(item.title)}" loading="lazy">
        <div class="item-body">
          <div class="item-meta"><span>${escapeHtml(item.category)}</span><span class="item-location">${escapeHtml(item.location)}</span></div>
          <h3 class="item-title">${escapeHtml(item.title)}</h3>
          <p class="item-description">${escapeHtml(item.description)}</p>
          <div class="item-tags"><span class="pill">${escapeHtml(item.purpose)}</span><span class="pill">${escapeHtml(item.item_condition)}</span></div>
          <button class="button chat-item-button" data-item-id="${escapeHtml(item.id)}">Chat with poster ↗</button>
        </div>
      </article>`).join("");

    $$(".chat-item-button").forEach((button) => {
      button.addEventListener("click", () => {
        const item = items.find((entry) => entry.id === button.dataset.itemId);
        if (item && currentUser?.id === item.owner_id) {
          showToast("This is your listing.");
          return;
        }
        if (requireMember("chat", button.dataset.itemId)) startChat(button.dataset.itemId);
      });
    });
  }

  function openListingDialog() {
    if (!requireMember("list")) return;
    showFormMessage("#listing-message", "");
    if (!listingDialog.open) listingDialog.showModal();
  }

  async function publishItem(event) {
    event.preventDefault();
    if (!requireMember("list")) return;

    const form = event.currentTarget;
    const button = $("#publish-button");
    const file = $("#item-photo").files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showFormMessage("#listing-message", "Please choose an image file.");
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      showFormMessage("#listing-message", "Please choose an image smaller than 6 MB.");
      return;
    }

    button.disabled = true;
    button.textContent = "Publishing…";
    showFormMessage("#listing-message", "");
    let uploadedPath = "";
    try {
      const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      uploadedPath = `${currentUser.id}/${crypto.randomUUID()}.${extension || "jpg"}`;
      const { error: uploadError } = await db.storage.from("item-images").upload(uploadedPath, file, {
        cacheControl: "3600", upsert: false, contentType: file.type
      });
      if (uploadError) throw uploadError;

      const payload = {
        owner_id: currentUser.id,
        title: $("#item-title").value.trim(),
        category: $("#item-category").value,
        description: $("#item-description").value.trim(),
        item_condition: $("#item-condition").value,
        purpose: $("#item-purpose").value,
        location: $("#item-location").value.trim(),
        image_path: uploadedPath,
        status: "available"
      };
      const { error: insertError } = await db.from("items").insert(payload);
      if (insertError) throw insertError;

      form.reset();
      listingDialog.close();
      showToast("Listing published successfully.");
      await loadItems();
      window.location.hash = "#exchange";
    } catch (error) {
      if (uploadedPath) {
        const { error: cleanupError } = await db.storage.from("item-images").remove([uploadedPath]);
        if (cleanupError) console.warn("Temporary upload needs cleanup:", cleanupError.message);
      }
      showFormMessage("#listing-message", error.message || "Could not publish this listing. Please try again.");
    } finally {
      button.disabled = false;
      button.textContent = "Publish listing ↗";
    }
  }

  async function startChat(itemId) {
    if (!requireMember("chat", itemId)) return;
    showToast("Opening conversation…");
    const { data, error } = await db.rpc("create_conversation", { p_item_id: itemId });
    if (error) {
      showToast(error.message.includes("own listing") ? "You cannot message yourself." : "Could not open this conversation.");
      console.error("Conversation create failed:", error.message);
      return;
    }
    await openConversation(data, true);
  }

  async function openInbox() {
    if (!requireMember("inbox")) return;
    unsubscribeFromChat();
    activeConversationId = null;
    $("#conversation-view").hidden = true;
    $("#inbox-view").hidden = false;
    showFormMessage("#inbox-message", "");
    $("#conversation-list").innerHTML = '<p class="muted">Loading your conversations…</p>';
    if (!messagesDialog.open) messagesDialog.showModal();
    await loadInbox();
  }

  async function loadInbox() {
    const list = $("#conversation-list");
    const { data: conversations, error } = await db.from("conversations")
      .select("id,item_id,viewer_id,poster_id,last_message_at")
      .order("last_message_at", { ascending: false });
    if (error) {
      list.innerHTML = "";
      showFormMessage("#inbox-message", "Your chats could not be loaded. Please try again.");
      return;
    }
    inboxItems = conversations || [];
    if (!inboxItems.length) {
      list.innerHTML = '<p class="muted">No chats yet. Open a listing and choose “Chat with poster” to start a private conversation.</p>';
      return;
    }

    const itemIds = [...new Set(inboxItems.map((chat) => chat.item_id))];
    const memberIds = [...new Set(inboxItems.map((chat) => chat.viewer_id === currentUser.id ? chat.poster_id : chat.viewer_id))];
    const [{ data: itemRows }, { data: profiles }] = await Promise.all([
      db.from("items").select("id,title").in("id", itemIds),
      db.from("profiles").select("id,display_name,email").in("id", memberIds)
    ]);
    const itemMap = new Map((itemRows || []).map((item) => [item.id, item]));
    const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
    list.innerHTML = inboxItems.map((chat) => {
      const otherId = chat.viewer_id === currentUser.id ? chat.poster_id : chat.viewer_id;
      const other = profileMap.get(otherId);
      const item = itemMap.get(chat.item_id);
      const otherName = other?.display_name || other?.email || "MCC member";
      return `<button class="conversation-row" type="button" data-conversation-id="${escapeHtml(chat.id)}">
        <span class="conversation-avatar" aria-hidden="true">↻</span><span class="conversation-text"><strong>${escapeHtml(item?.title || "Item conversation")}</strong><small>${escapeHtml(otherName)}</small></span><span class="conversation-arrow">↗</span>
      </button>`;
    }).join("");
    $$(".conversation-row").forEach((button) => button.addEventListener("click", () => openConversation(button.dataset.conversationId, true)));
  }

  async function openConversation(conversationId, showBack) {
    unsubscribeFromChat();
    activeConversationId = conversationId;
    showFormMessage("#chat-message", "");
    $("#inbox-view").hidden = true;
    $("#conversation-view").hidden = false;
    $("#back-to-inbox").hidden = !showBack;
    $("#conversation-title").textContent = "Private chat";
    $("#conversation-subtitle").textContent = "Loading conversation…";
    $("#message-list").innerHTML = '<p class="message-empty">Loading messages…</p>';
    if (!messagesDialog.open) messagesDialog.showModal();

    const { data: conversation, error } = await db.from("conversations").select("id,item_id,viewer_id,poster_id").eq("id", conversationId).single();
    if (error || !conversation) {
      showFormMessage("#chat-message", "This conversation is no longer available.");
      return;
    }
    const otherId = conversation.viewer_id === currentUser.id ? conversation.poster_id : conversation.viewer_id;
    const [{ data: item }, { data: other }] = await Promise.all([
      db.from("items").select("id,title").eq("id", conversation.item_id).maybeSingle(),
      db.from("profiles").select("display_name,email").eq("id", otherId).maybeSingle()
    ]);
    $("#conversation-title").textContent = item?.title || "Item conversation";
    $("#conversation-subtitle").textContent = other?.email || other?.display_name || "MCC member";
    await loadMessages(conversationId);
    activeChannel = db.channel(`reloop-chat-${conversationId}`)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}`
      }, () => loadMessages(conversationId))
      .subscribe();
  }

  async function loadMessages(conversationId) {
    if (conversationId !== activeConversationId) return;
    const { data, error } = await db.from("messages")
      .select("id,conversation_id,sender_id,body,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) {
      $("#message-list").innerHTML = '<p class="message-empty">Messages could not be loaded. Please reopen the chat.</p>';
      return;
    }
    const list = $("#message-list");
    if (!data?.length) {
      list.innerHTML = '<p class="message-empty">Say hello to start the conversation.</p>';
    } else {
      list.innerHTML = data.map((message) => `<article class="message ${message.sender_id === currentUser.id ? "mine" : ""}"><p>${escapeHtml(message.body)}</p><time>${escapeHtml(new Date(message.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }))}</time></article>`).join("");
    }
    list.scrollTop = list.scrollHeight;
  }

  function unsubscribeFromChat() {
    if (activeChannel) {
      db.removeChannel(activeChannel);
      activeChannel = null;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!currentUser || !activeConversationId) return;
    const input = $("#message-input");
    const body = input.value.trim();
    if (!body) return;
    const button = $("#send-message-button");
    button.disabled = true;
    const { error } = await db.from("messages").insert({
      conversation_id: activeConversationId,
      sender_id: currentUser.id,
      body
    });
    button.disabled = false;
    if (error) {
      showFormMessage("#chat-message", error.message || "Message was not sent.");
      return;
    }
    input.value = "";
    showFormMessage("#chat-message", "");
    await loadMessages(activeConversationId);
    await loadInbox();
  }

  async function signOut() {
    await db.auth.signOut();
    currentUser = null;
    setAccountUI();
    showToast("Signed out.");
    await loadItems();
    if (messagesDialog.open) messagesDialog.close();
  }

  // Header, dialogs and listing form.
  $("#google-signin-button").addEventListener("click", signInWithGoogle);
  $("#account-button").addEventListener("click", () => currentUser ? signOut() : openSignIn());
  $("#my-chats-button").addEventListener("click", openInbox);
  ["#list-item-button", "#hero-list-button", "#section-list-button", "#empty-list-button"].forEach((selector) => $(selector).addEventListener("click", openListingDialog));
  $("#listing-form").addEventListener("submit", publishItem);
  $("#search-input").addEventListener("input", renderItems);
  $("#category-filter").addEventListener("change", renderItems);
  $("#message-form").addEventListener("submit", sendMessage);
  $("#back-to-inbox").addEventListener("click", async () => {
    unsubscribeFromChat();
    activeConversationId = null;
    $("#conversation-view").hidden = true;
    $("#inbox-view").hidden = false;
    await loadInbox();
  });
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
  messagesDialog.addEventListener("close", () => {
    unsubscribeFromChat();
    activeConversationId = null;
  });
  $("#menu-button").addEventListener("click", () => {
    const nav = $("#main-nav");
    const isOpen = nav.classList.toggle("open");
    $("#menu-button").setAttribute("aria-expanded", String(isOpen));
  });
  $$("#main-nav a").forEach((link) => link.addEventListener("click", () => {
    $("#main-nav").classList.remove("open");
    $("#menu-button").setAttribute("aria-expanded", "false");
  }));

  // Establish the existing session and keep the header in sync with sign-in/out.
  db.auth.onAuthStateChange((_event, session) => {
    const nextUser = session?.user || null;
    if (nextUser && !isMccEmail(nextUser.email)) {
      db.auth.signOut();
      currentUser = null;
      setAccountUI();
      openSignIn("Please use a verified Google account ending in @mcc.edu.in.");
      return;
    }
    currentUser = nextUser;
    setAccountUI();
    loadItems();
    if (currentUser) runPendingAction();
  });
  db.auth.getSession().then(({ data }) => handleSession(data.session));
})();
