var uploads = new Map();

function getBasicAuthHeader(username, password) {
  return `Basic ${btoa(username + ':' + password)}`;
}

function generateCnonce() {
  const array = new Uint8Array(16);
  window.crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function escapeDigestValue(value) {
  return value.replace(/"/g, '\\"');
}

function parseDigestChallenge(challenge) {
  const params = {};
  const regex = /(\w+)=("([^"]+)"|([^,]+))/g;
  let match;
  while ((match = regex.exec(challenge))) {
    const key = match[1];
    const value = match[3] || match[4];
    params[key] = value;
  }
  return params;
}

async function getDigestAuthHeader(url, username, password, method = "PUT") {
  const response = await fetch(url, { method: "HEAD" });

  if (response.status !== 401) throw new Error("No Digest challenge");

  const wwwAuth = response.headers.get("WWW-Authenticate");
  if (!wwwAuth || !wwwAuth.includes("Digest")) {
    throw new Error("Server did not return Digest challenge");
  }

  const digestParams = parseDigestChallenge(wwwAuth);
  const uri = new URL(url).pathname;
  const { realm, nonce, qop, algorithm = "MD5" } = digestParams;

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  // TODO: Replace fixed nc="00000001" with an incrementing counter
  //       when server requires sequential values.
  //       Implementation should:
  //       1. Track current nonce (e.g., using sessionStorage)
  //       2. Increment nc for each request with the same nonce
  //       3. Reset to "00000001" when receiving a new nonce from server
  //       Example:
  //       let nc = nonceStorage.get(nonce) || "00000001";
  //       nonceStorage.set(nonce, incrementHexCounter(nc));
  const nc = "00000001";
  const cnonce = qop ? generateCnonce() : undefined;

  let responseHash;
  if (qop === "auth") {
    responseHash = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    responseHash = md5(`${ha1}:${nonce}:${ha2}`);
  }

  const headerParts = [
    `Digest username="${escapeDigestValue(username)}"`,
    `realm="${escapeDigestValue(realm)}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${responseHash}"`,
    algorithm && `algorithm="${algorithm}"`,
    qop && `qop="${qop}"`,
    nc && `nc=${nc}`,
    cnonce && `cnonce="${cnonce}"`,
  ].filter(Boolean);

  return headerParts.join(", ");
}

async function getConfiguration(accountId) {
  const all = await browser.storage.local.get([accountId]);
  if (!all[accountId] || !all[accountId].private_url) {
    throw new Error("No URLs found.");
  }
  return all[accountId];
}

browser.cloudFile.onFileUpload.addListener(async (account, {id, name, data }) => {
  const abortController = new AbortController();
    uploads.set(id, {
      name: name,
      url: null,
      abortController: abortController,
      status: 'uploading'
    });

  let configuration = await getConfiguration(account.id);
  let relativePath = `${configuration.folder}/${encodeURIComponent(name)}`;
  let url = configuration.private_url + relativePath;

  uploads.get(id).url = url;

  let authHeader;
  if (configuration.auth_type === "basic") {
    authHeader = getBasicAuthHeader(configuration.username, configuration.password);
  } else if (configuration.auth_type === "digest") {
    authHeader = await getDigestAuthHeader(url, configuration.username, configuration.password, "PUT");
  }
  
  let headers = {
    "Content-Type": "application/octet-stream",
    "User-Agent": "Filelink for WebDav v" + browser.runtime.getManifest().version,
    "Authorization": authHeader
  };

  let fetchInfo = {
    method: "PUT",
    headers,
    body: data,
    signal: abortController.signal
  };

  let response = await fetch(url, fetchInfo);
  uploads.get(id).status = 'completed';

  if (response.status === 401 && configuration.auth_type === "basic") {
    console.warn("Server requires Digest auth, switching...");
    authHeader = await getDigestAuthHeader(url, configuration.username, configuration.password, "PUT");
    headers.Authorization = authHeader;
    fetchInfo.headers = headers;
    response = await fetch(url, fetchInfo);
  }

  if (response.status === 401) {
    throw new Error("Invalid credentials");
  }

  if (response.status > 299) {
    throw new Error("Response was not ok");
  }

  if (configuration.public_url) {
    return { url: configuration.public_url + encodeURIComponent(name) };
  }
  return { url };
});

browser.cloudFile.onFileUploadAbort.addListener((id) => {
  try {
    const uploadInfo = uploads.get(id);
    
    if (!uploadInfo) {
      console.warn(`Upload abort requested for non-existent ID: ${id}`);
      return;
    }

    if (uploadInfo.abortController) {
      console.log(`Aborting upload for ID: ${id}`);
      uploadInfo.abortController.abort();
      
      if (uploadInfo.uploadStream) {
        uploadInfo.uploadStream.cancel().catch(e => {
          console.error('Error canceling upload stream:', e);
        });
      }
      
      uploads.delete(id);
      
      if (uploadInfo.url) {
        fetch(uploadInfo.url, { 
          method: 'DELETE',
          signal: AbortSignal.timeout(3000)
        }).catch(e => {
          console.warn('Server cancellation failed:', e);
        });
      }
    } else {
      console.warn(`No abortController found for ID: ${id}`);
    }
  } catch (error) {
    console.error('Error during upload abortion:', error);
    uploads.delete(id);
  }
});

browser.cloudFile.onFileDeleted.addListener(async (account, id) => {
  const uploadInfo = uploads.get(id);
  if (!uploadInfo) {
    console.warn(`No upload info found for id: ${id}`);
    return;
  }

  const configuration = await getConfiguration(account.id);
  const fileName = uploadInfo.name;
  const relativePath = `${configuration.folder}/${encodeURIComponent(fileName)}`;
  const url = new URL(relativePath, configuration.private_url).href;

  let authHeader;
  if (configuration.auth_type === "basic") {
    authHeader = getBasicAuthHeader(configuration.username, configuration.password);
  } else if (configuration.auth_type === "digest") {
    authHeader = await getDigestAuthHeader(url, configuration.username, configuration.password, "DELETE");
  } else {
    throw new Error("Unknown auth type");
  }

  const fetchInfo = {
    method: "DELETE",
    headers: {
      "User-Agent": "Filelink for WebDav v" + browser.runtime.getManifest().version,
      "Authorization": authHeader
    }
  };

  let response = await fetch(url, fetchInfo);

  if (response.status === 401) {
    throw new Error("Invalid credentials");
  }

  uploads.delete(id);
  if (response.status > 299) {
    throw new Error("Delete failed: " + response.status);
  }
});

browser.cloudFile.getAllAccounts().then(async (accounts) => {
  const all = await browser.storage.local.get();
  let badConfig = false;
  for (let account of accounts) {
    const config = all[account.id];
    const isConfigured = config && config.status === 200;

    await browser.cloudFile.updateAccount(account.id, {
      configured: isConfigured
    });
    if (!isConfigured) badConfig = true;
  }

  if (badConfig) {
    browser.notifications.create({
      type: "basic",
      title: browser.i18n.getMessage("extensionName"),
      message: browser.i18n.getMessage("status-not-configured"),
    })
  }
});

browser.cloudFile.onAccountDeleted.addListener((accountId) => {
  browser.storage.local.remove(accountId);
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === "list-folders") {
    const { url, username, password, auth_type } = message;

    let headers = {
      "User-Agent": "Filelink for WebDav v" + browser.runtime.getManifest().version,
    };

    try {
      if (auth_type === "basic") {
        headers["Authorization"] = "Basic " + btoa(`${username}:${password}`);
      } else if (auth_type === "digest") {
        headers["Authorization"] = await getDigestAuthHeader(url, username, password, "PROPFIND");
      }

      const xmlBody = `
        <d:propfind xmlns:d="DAV:">
          <d:prop><d:resourcetype/></d:prop>
        </d:propfind>`.trim();

      const response = await fetch(url, {
        method: "PROPFIND",
        headers: {
          ...headers,
          "Depth": "1",
          "Content-Type": "application/xml"
        },
        body: xmlBody
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };

    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }
});
