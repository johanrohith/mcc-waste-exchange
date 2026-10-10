/* MCC ReLoop: public listing page, Google sign-in and private chats. */
(() => {
  const db = window.reloop.db;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  let currentUser = null;
  let profileDisplayName = "";
  let items = [];
  let activeConversationId = null;
  let activeChannel = null;
  let activeInboxChannel = null;
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

  // MCC Workspace names commonly look like: "JOHAN ROHITH A G Computer Applications".
  // First detect the boundary by format, so newly named departments do not need to be listed:
  // an all-caps person-name prefix (including initials) followed by a Title Case department.
  // A known-suffix fallback handles accounts whose name/suffix casing differs from that pattern.
  function cleanDisplayName(value) {
    if (typeof value !== "string") return "";
    let name = value.trim().replace(/\s+/g, " ");
    if (!name || name.includes("@")) return "";

    const words = name.split(" ");
    for (let splitAt = 2; splitAt < words.length; splitAt += 1) {
      const namePart = words.slice(0, splitAt);
      const departmentStart = words[splitAt];
      const looksLikeUppercaseStudentName = namePart.every((word) =>
        /^[A-Z]$/.test(word) || /^[A-Z][A-Z.'’\-]*$/.test(word)
      );
      if (looksLikeUppercaseStudentName && /^[A-Z][a-z]/.test(departmentStart)) {
        return namePart.join(" ");
      }
    }

    // Fallback for common department suffixes when capitalization is inconsistent.
    // This is not the primary method; the case-pattern above supports new Title Case departments.
    const departmentSuffixes = [
      "Advanced Zoology and Biotechnology", "Plant Biology and Plant Biotechnology",
      "Computer Science and Applications", "Computer Applications", "Computer Science",
      "Visual Communication", "Corporate Secretaryship", "Political Science",
      "Public Administration", "Business Administration", "Business Management",
      "Information Technology", "Information Systems", "Mass Communication",
      "Physical Education", "Physical Sciences", "Life Sciences", "Social Work",
      "Plant Biology", "Microbiology", "Biotechnology", "Mathematics and Statistics",
      "Zoology", "Botany", "Physics", "Chemistry", "Mathematics", "Statistics",
      "Economics", "Commerce", "English", "Tamil", "French", "Hindi", "Sanskrit",
      "History", "Philosophy", "Psychology", "Sociology", "Data Science", "Journalism",
      "Computer Technology", "Commerce and Corporate Secretaryship", "B.Com", "BCA",
      "MCA", "B.Sc", "M.Sc", "M.Com"
    ].sort((a, b) => b.length - a.length);

    const lowerName = name.toLocaleLowerCase();
    for (const department of departmentSuffixes) {
      const suffix = ` ${department.toLocaleLowerCase()}`;
      if (lowerName.endsWith(suffix)) {
        return name.slice(0, -suffix.length).trim();
      }
    }

    return name;
  }

  function getDisplayName(user) {
    if (!user) return "";
    const metadata = user.user_metadata || {};
    const structuredName = [metadata.given_name, metadata.family_name]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ");
    const rawCandidates = [structuredName, profileDisplayName, metadata.full_name, metadata.name, metadata.display_name]
      .filter((value) => typeof value === "string" && value.trim());
    const candidates = rawCandidates.map((raw) => {
      const normalized = raw.trim().replace(/\s+/g, " ");
      const cleaned = cleanDisplayName(normalized);
      return { cleaned, departmentRemoved: Boolean(cleaned) && cleaned.length < normalized.length };
    }).filter((candidate) => candidate.cleaned);

    // If any provider/profile field clearly had a department removed, prefer that cleaned value
    // over a longer, unparsed variant from another metadata field.
    const parsedCandidates = candidates.filter((candidate) => candidate.departmentRemoved);
    const bestCandidates = parsedCandidates.length ? parsedCandidates : candidates;
    bestCandidates.sort((a, b) => b.cleaned.length - a.cleaned.length);
    return bestCandidates[0]?.cleaned || cleanDisplayName(user.email?.split("@")[0]) || "MCC member";
  }

  function setAccountUI() {
    const signInButton = $("#account-button");
    const accountMenu = $("#account-menu");
    const accountName = $("#account-name");
    const mobileAccount = $("#mobile-account");
    const mobileAccountName = $("#mobile-account-name");
    const chatsButton = $("#my-chats-button");
    if (currentUser) {
      const name = getDisplayName(currentUser);
      signInButton.hidden = true;
      accountMenu.hidden = false;
      accountName.textContent = name;
      accountName.title = name;
      mobileAccount.hidden = false;
      mobileAccountName.textContent = name;
      mobileAccountName.title = name;
      chatsButton.hidden = false;
    } else {
      signInButton.hidden = false;
      accountMenu.hidden = true;
      accountName.textContent = "";
      accountName.removeAttribute("title");
      mobileAccount.hidden = true;
      mobileAccountName.textContent = "";
      mobileAccountName.removeAttribute("title");
      chatsButton.hidden = true;
      profileDisplayName = "";
    }
  }

  async function refreshProfileDisplayName(user) {
    if (!user) return;
    const { data, error } = await db.from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    if (error || currentUser?.id !== user.id) return;
    if (typeof data?.display_name === "string" && data.display_name.trim()) {
      profileDisplayName = data.display_name.trim();
      setAccountUI();
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
    profileDisplayName = "";
    setAccountUI();
    if (currentUser) void refreshProfileDisplayName(currentUser);
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

    $("#item-grid").innerHTML = shown.map((item) => {
      const isOwner = currentUser?.id === item.owner_id;
      const action = isOwner
        ? `<button class="button button-outline owner-status-button" type="button" data-item-id="${escapeHtml(item.id)}">✓ Mark as exchanged</button>`
        : `<button class="button chat-item-button" type="button" data-item-id="${escapeHtml(item.id)}">Chat with poster ↗</button>`;
      return `
      <article class="item-card">
        <img class="item-image" src="${escapeHtml(itemImageUrl(item.image_path))}" alt="${escapeHtml(item.title)}" loading="lazy">
        <div class="item-body">
          <div class="item-meta"><span>${escapeHtml(item.category)}</span><span class="item-location">${escapeHtml(item.location)}</span></div>
          <h3 class="item-title">${escapeHtml(item.title)}</h3>
          <p class="item-description">${escapeHtml(item.description)}</p>
          <div class="item-tags"><span class="pill">${escapeHtml(item.purpose)}</span><span class="pill">${escapeHtml(item.item_condition)}</span></div>
          ${action}
        </div>
      </article>`;
    }).join("");

    $$(".chat-item-button").forEach((button) => {
      button.addEventListener("click", () => {
        if (requireMember("chat", button.dataset.itemId)) startChat(button.dataset.itemId);
      });
    });
    $$(".owner-status-button").forEach((button) => {
      button.addEventListener("click", () => markItemExchanged(button.dataset.itemId, button));
    });
  }

  async function markItemExchanged(itemId, button) {
    const item = items.find((entry) => entry.id === itemId);
    if (!currentUser || !item || item.owner_id !== currentUser.id) {
      showToast("Only the poster can update this listing.");
      return;
    }
    if (!window.confirm(`Mark “${item.title}” as exchanged? It will be removed from the public listings.`)) return;

    button.disabled = true;
    button.textContent = "Updating…";
    const { error } = await db.from("items")
      .update({ status: "unavailable" })
      .eq("id", itemId)
      .eq("owner_id", currentUser.id);

    if (error) {
      button.disabled = false;
      button.textContent = "✓ Mark as exchanged";
      console.error("Listing status update failed:", error.message);
      showToast("Could not update this listing. Please try again.");
      return;
    }

    showToast("Marked as exchanged. The listing is no longer public.");
    await loadItems();
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
    subscribeToInbox();
    await loadInbox();
  }

  async function loadInbox() {
    if (!currentUser) return;
    const list = $("#conversation-list");
    const { data: conversations, error } = await db.from("conversations")
      .select("id,item_id,viewer_id,poster_id,last_message_at,created_at")
      .order("last_message_at", { ascending: false });

    if (error) {
      list.innerHTML = "";
      showFormMessage("#inbox-message", "Your chats could not be loaded. Please refresh and try again.");
      console.error("ReLoop inbox load failed:", error.message);
      return;
    }

    inboxItems = conversations || [];
    if (!inboxItems.length) {
      list.innerHTML = `
        <section class="conversation-section">
          <h3 class="conversation-section-title">People interested in your listings</h3>
          <p class="conversation-section-empty">No one has started a conversation about your listings yet.</p>
        </section>
        <section class="conversation-section">
          <h3 class="conversation-section-title">Your enquiries</h3>
          <p class="conversation-section-empty">When you contact a poster, your conversation will appear here.</p>
        </section>`;
      showFormMessage("#inbox-message", "");
      return;
    }

    const itemIds = [...new Set(inboxItems.map((chat) => chat.item_id))];
    const otherMemberIds = [...new Set(inboxItems.map((chat) =>
      chat.viewer_id === currentUser.id ? chat.poster_id : chat.viewer_id
    ))];
    const conversationIds = inboxItems.map((chat) => chat.id);
    const [itemsResult, profilesResult, messagesResult] = await Promise.all([
      db.from("items").select("id,title").in("id", itemIds),
      db.from("profiles").select("id,display_name,email").in("id", otherMemberIds),
      db.from("messages").select("id,conversation_id,sender_id,body,created_at")
        .in("conversation_id", conversationIds).order("created_at", { ascending: false })
    ]);

    if (itemsResult.error || profilesResult.error) {
      showFormMessage("#inbox-message", "Some contact or listing details could not be loaded. You can still open a conversation.");
      console.error("Inbox details failed:", itemsResult.error?.message, profilesResult.error?.message);
    } else {
      showFormMessage("#inbox-message", messagesResult.error ? "Latest message previews are temporarily unavailable; open a chat to read messages." : "");
    }

    const itemMap = new Map((itemsResult.data || []).map((item) => [item.id, item]));
    const profileMap = new Map((profilesResult.data || []).map((profile) => [profile.id, profile]));
    const latestMessageMap = new Map();
    // Messages arrive sorted newest-first, so the first row for each chat is its preview.
    for (const message of messagesResult.data || []) {
      if (!latestMessageMap.has(message.conversation_id)) {
        latestMessageMap.set(message.conversation_id, message);
      }
    }

    const incoming = inboxItems.filter((chat) => chat.poster_id === currentUser.id);
    const outgoing = inboxItems.filter((chat) => chat.viewer_id === currentUser.id);
    const renderRows = (rows, kind) => rows.map((chat) => {
      const otherId = chat.viewer_id === currentUser.id ? chat.poster_id : chat.viewer_id;
      const other = profileMap.get(otherId);
      const item = itemMap.get(chat.item_id);
      const otherName = cleanDisplayName(other?.display_name) || other?.email || "MCC member";
      const itemTitle = item?.title || "Item conversation";
      const latest = latestMessageMap.get(chat.id);
      const preview = latest
        ? `${latest.sender_id === currentUser.id ? "You" : otherName}: ${latest.body}`
        : "Conversation opened · no messages yet";
      const previewDate = latest?.created_at || chat.last_message_at || chat.created_at;
      const formattedDate = previewDate
        ? new Date(previewDate).toLocaleDateString([], { day: "numeric", month: "short" })
        : "";
      const initials = otherName.trim().charAt(0).toUpperCase() || "M";
      return `<button class="conversation-row ${kind}" type="button" data-conversation-id="${escapeHtml(chat.id)}">
        <span class="conversation-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
        <span class="conversation-text">
          <span class="conversation-topline"><strong>${escapeHtml(otherName)}</strong><span class="conversation-role">${kind === "incoming" ? "Interested in your listing" : "Your enquiry"}</span></span>
          <span class="conversation-item">Re: ${escapeHtml(itemTitle)}</span>
          <small class="conversation-preview">${escapeHtml(preview)}</small>
        </span>
        <span class="conversation-end"><time>${escapeHtml(formattedDate)}</time><span class="conversation-arrow" aria-hidden="true">↗</span></span>
      </button>`;
    }).join("");

    list.innerHTML = `
      <section class="conversation-section">
        <h3 class="conversation-section-title">People interested in your listings <span>${incoming.length}</span></h3>
        ${incoming.length ? `<div class="conversation-section-list">${renderRows(incoming, "incoming")}</div>` : '<p class="conversation-section-empty">No one has started a conversation about your listings yet.</p>'}
      </section>
      <section class="conversation-section">
        <h3 class="conversation-section-title">Your enquiries <span>${outgoing.length}</span></h3>
        ${outgoing.length ? `<div class="conversation-section-list">${renderRows(outgoing, "outgoing")}</div>` : '<p class="conversation-section-empty">Conversations you start with posters will appear here.</p>'}
      </section>`;

    $$(".conversation-row").forEach((button) => button.addEventListener("click", () => {
      openConversation(button.dataset.conversationId, true);
    }));
  }

  function subscribeToInbox() {
    unsubscribeFromInbox();
    if (!currentUser) return;
    activeInboxChannel = db.channel(`reloop-inbox-${currentUser.id}`)
      // The messages table is enabled in Supabase Realtime by the existing schema.
      // Refresh the inbox on any incoming message so a newly created conversation
      // also appears even if it was not in inboxItems when the modal was opened.
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "messages"
      }, (payload) => {
        if (payload.new?.sender_id !== currentUser?.id) void loadInbox();
      })
      .subscribe();
  }

  function unsubscribeFromInbox() {
    if (activeInboxChannel) {
      db.removeChannel(activeInboxChannel);
      activeInboxChannel = null;
    }
  }

  async function openConversation(conversationId, showBack) {
    unsubscribeFromInbox();
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
    $("#conversation-subtitle").textContent = cleanDisplayName(other?.display_name) || other?.email || "MCC member";
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
    unsubscribeFromInbox();
    unsubscribeFromChat();
    const { error } = await db.auth.signOut();
    if (error) {
      showToast("Couldn't sign out. Please try again.");
      return;
    }
    currentUser = null;
    profileDisplayName = "";
    setAccountUI();
    showToast("Signed out.");
    await loadItems();
    if (messagesDialog.open) messagesDialog.close();
  }

  // Header, dialogs and listing form.
  $("#google-signin-button").addEventListener("click", signInWithGoogle);
  $("#account-button").addEventListener("click", openSignIn);
  $("#signout-button").addEventListener("click", signOut);
  $("#mobile-signout-button").addEventListener("click", signOut);
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
    subscribeToInbox();
    await loadInbox();
  });
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
  messagesDialog.addEventListener("close", () => {
    unsubscribeFromInbox();
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
    profileDisplayName = "";
    setAccountUI();
    if (currentUser) void refreshProfileDisplayName(currentUser);
    loadItems();
    if (currentUser) runPendingAction();
  });
  db.auth.getSession().then(({ data }) => handleSession(data.session));
})();
