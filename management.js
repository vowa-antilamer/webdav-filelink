let form = document.querySelector("form");
let private_url = form.querySelector(`input[name="private_url"]`);
let public_url = form.querySelector(`input[name="public_url"]`);
let username = form.querySelector(`input[name="username"]`);
let password = form.querySelector(`input[name="password"]`);
let authType = form.querySelector(`select[name="auth_type"]`);
let folder_select = form.querySelector(`select[name="folder"]`);

let button = form.querySelector(`button[name="save_button"]`);
let refresh_button = form.querySelector(`button[name="refresh_button"]`);
let accountId = new URL(location.href).searchParams.get("accountId");

function setNotification(status, text) {
  const notifications = document.getElementById("notifications");
  notifications.textContent = text;
  notifications.dataset.status = status ? "ok" : "fail";
}

function clearNotification() {
  const notifications = document.getElementById("notifications");
  notifications.dataset.status = "hidden";
  notifications.textContent = "";
}

function getHumanReadableStatusCode(code) {
  switch (code) {
    case 0:
      return browser.i18n.getMessage(`status-connection-error`)
    case 200:
    case 401:
    case 503:
      return browser.i18n.getMessage(`status-code-${code}`)
    default:
      return browser.i18n.getMessage(`status-code`, [code])
  }
}

(() => {
  for (let element of document.querySelectorAll("[data-message]")) {
    element.textContent = browser.i18n.getMessage(element.dataset.message);
  }
})();

browser.storage.local.get([accountId]).then(accountInfo => {
  if (accountId in accountInfo) {
    if ("private_url" in accountInfo[accountId]) {
      private_url.value = accountInfo[accountId].private_url;
    }
    if ("public_url" in accountInfo[accountId]) {
      public_url.value = accountInfo[accountId].public_url;
    }
    if ("username" in accountInfo[accountId]) {
      username.value = accountInfo[accountId].username;
    }
    if ("password" in accountInfo[accountId]) {
      password.value = accountInfo[accountId].password;
    }
    if ("auth_type" in accountInfo[accountId]) {
      authType.value = accountInfo[accountId].auth_type;
    } else {
      authType.value = "basic";
    }
    if ("folder" in accountInfo[accountId]) {
      const storedFolder = accountInfo[accountId].folder;
      folder_select.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = storedFolder;
      opt.textContent = storedFolder;
      opt.selected = true;
      folder_select.appendChild(opt);
    }
    if ("status" in accountInfo[accountId]) {
      const status = accountInfo[accountId].status;
      if (status != 200) {
        setNotification(false, getHumanReadableStatusCode(status));
      }
    }
  }
});

// Check status.
browser.cloudFile.getAllAccounts()
  .then(accounts => accounts.find(a => a.id == accountId))
  .then(account => {
    if (!account.configured) {
      setNotification(false, browser.i18n.getMessage("status-not-configured"));
    }
  })

button.onclick = async () => {
  if (!form.checkValidity()) {
    return;
  }

  private_url.disabled = public_url.disabled = button.disabled = true;
  let private_url_value = private_url.value;
  if (!private_url_value.endsWith("/")) {
    private_url_value += "/";
    private_url.value = private_url_value;
  }
  let public_url_value = public_url.value || private_url_value;
  public_url.value = public_url_value;

  // Validate.
  let headers = {
    "User-Agent": "Filelink for WebDav v" + browser.runtime.getManifest().version,
    "Authorization": `Basic ${btoa(username.value + ':' + password.value)}`
  };
  let fetchInfo = {
    headers,
    method: "OPTIONS",
  };
  let response = await fetch(private_url_value, fetchInfo).catch(e => {
    console.info(e);
    return {
      ok: false,
      status: 0
    }
  });

  await browser.cloudFile.updateAccount(accountId, { configured: response.ok });
  setNotification(response.ok, getHumanReadableStatusCode(response.status));

  await browser.storage.local.set({
    [accountId]: {
      private_url: private_url_value,
      public_url: public_url_value,
      password: password.value,
      username: username.value,
      auth_type: authType.value,
      folder: folder_select.value,
      status: response.status
    },
  });

  await new Promise(resolve => setTimeout(resolve, 1000));
  private_url.disabled = public_url.disabled = button.disabled = false;

};

refresh_button.onclick = async () => {
  if (!form.checkValidity()) {
    return;
  }

  refresh_button.disabled = true;
  let url = private_url.value;
  if (!url.endsWith("/")) url += "/";

  const auth_type = authType.value;
  const usernameVal = username.value;
  const passwordVal = password.value;

  try {
    const response = await browser.runtime.sendMessage({
      type: "list-folders",
      url,
      username: usernameVal,
      password: passwordVal,
      auth_type
    });

    if (!response.ok) throw new Error(`Error request: ${response.status}`);

    const parser = new DOMParser();
    const xml = parser.parseFromString(response.text, "application/xml");
    const responses = [...xml.getElementsByTagName("d:response")];

    folder_select.innerHTML = "";

    const basePath = new URL(url).pathname;

    responses.forEach((resp) => {
      const href = resp.getElementsByTagName("d:href")[0]?.textContent;
      const isCollection = !!resp.getElementsByTagName("d:collection")[0];
      if (!href || !isCollection) return;

      const currentPath = new URL(href).pathname;
      let relative = currentPath.replace(basePath, "").replace(/\/$/, "");
      if (!relative || relative.includes("/")) return;

      relative = decodeURIComponent(relative);

      const opt = document.createElement("option");
      opt.value = relative;
      opt.textContent = relative;
      folder_select.appendChild(opt);
    });

  } catch (e) {
    alert("Error: " + e.message);
  }

  refresh_button.disabled = false;
};
