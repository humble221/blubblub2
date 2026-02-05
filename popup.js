// ======== Утилиты ========
const $ = id => document.getElementById(id);
const setStatus = (text, className = "") => {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + className;
};

// ======== Авторизация ========
const redirectToGitHubAuth = () => {
  const redirectUri = chrome.identity.getRedirectURL("callback");
  console.log("[AUTH] Запуск авторизации, redirectUri:", redirectUri);

  chrome.identity.launchWebAuthFlow(
    {
      url: `https://github.com/login/oauth/authorize?client_id=${chrome.runtime.getManifest().oauth2.client_id}&scope=repo&redirect_uri=${encodeURIComponent(redirectUri)}`,
      interactive: true
    },
    (redirectUrl) => {
      console.log("[AUTH] launchWebAuthFlow callback вызван");

      if (chrome.runtime.lastError) {
        console.error("[AUTH] Ошибка chrome:", chrome.runtime.lastError.message);
        setStatus("Ошибка авторизации: " + chrome.runtime.lastError.message, "error");
        return;
      }

      if (!redirectUrl) {
        console.warn("[AUTH] redirectUrl пустой");
        setStatus("Авторизация отменена или не завершена", "error");
        return;
      }

      console.log("[AUTH] Получен redirectUrl:", redirectUrl);

      const url = new URL(redirectUrl);
      const code = url.searchParams.get("code");

      if (code) {
        console.log("[AUTH] Код получен:", code);
        exchangeCodeForToken(code);
      } else {
        console.error("[AUTH] Код не найден в URL");
        setStatus("Не удалось получить код авторизации", "error");
      }
    }
  );
};

async function exchangeCodeForToken(code) {
  try {
    const clientSecret = '7f72041ae76d06ac0ee7e58b1c2961a84fdbbcdc';
    console.log("[TOKEN] Запрос токена, code:", code);

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json" },
      body: new URLSearchParams({
        client_id: chrome.runtime.getManifest().oauth2.client_id,
        client_secret: clientSecret,
        code
      })
    });

    const data = await resp.json();
    console.log("[TOKEN] Ответ от GitHub:", data);

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    if (!data.access_token) {
      throw new Error("access_token отсутствует в ответе");
    }

    await chrome.storage.local.set({ github_token: data.access_token });
    console.log("[TOKEN] Токен сохранён успешно");

    setStatus("Успешная авторизация!", "success");
    showMainInterface();  // это должно показать основной экран и загрузить репозитории
  } catch (err) {
    console.error("[TOKEN] Ошибка получения токена:", err);
    setStatus("Не удалось получить токен: " + err.message, "error");
  }
}


// ======== Проверка токена и показ интерфейса ========
async function init() {
  const { github_token } = await chrome.storage.local.get("github_token");
  if (github_token) {
    showMainInterface();
  } else {
    $("auth-section").style.display = "block";
    $("main-section").style.display = "none";
  }
}

function showMainInterface() {
  $("auth-section").style.display = "none";
  $("main-section").style.display = "block";

  $("logout-btn").onclick = async () => {
    await chrome.storage.local.remove("github_token");
    setStatus("Вы вышли из аккаунта", "success");
    init();   // самый простой и надёжный способ — перезапустить всю инициализацию
  };

  loadRepositories();
}


// ======== Работа с репозиториями ========
async function loadRepositories() {
  const token = (await chrome.storage.local.get("github_token")).github_token;
  if (!token) return;

  try {
    const resp = await fetch("https://api.github.com/user/repos?per_page=100", {
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json"
      }
    });
    if (!resp.ok) throw new Error(await resp.text());
    const repos = await resp.json();

    const select = $("repo-select");
    select.innerHTML = '<option value="">— выберите репозиторий —</option>';
    repos.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.full_name;
      opt.textContent = r.full_name;
      select.appendChild(opt);
    });

    $("select-folder-btn").disabled = false;
  } catch (err) {
    setStatus("Ошибка загрузки репозиториев: " + err.message, "error");
  }
}

// ======== Создание нового репозитория ========
$("create-repo-btn").onclick = async () => {
  const name = $("new-repo-name").value.trim();
  if (!name) return setStatus("Введите имя репозитория", "error");

  const token = (await chrome.storage.local.get("github_token")).github_token;

  try {
    const resp = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        private: false, // можно сделать настройку
        auto_init: true
      })
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.message || "Не удалось создать репозиторий");
    }

    setStatus(`Репозиторий ${name} создан!`, "success");
    $("new-repo-name").value = "";
    loadRepositories();
  } catch (err) {
    setStatus("Ошибка: " + err.message, "error");
  }
};

// ======== Выбор папки и загрузка ========
$("select-folder-btn").onclick = async () => {
  const repo = $("repo-select").value;
  if (!repo) return setStatus("Выберите репозиторий", "error");

  try {
    const dirHandle = await window.showDirectoryPicker();
    setStatus("Чтение структуры папки...");

    const files = await collectAllFiles(dirHandle, "");

    if (files.length === 0) {
      setStatus("В папке нет файлов", "error");
      return;
    }

    $("progress").style.display = "block";
    $("progress").value = 0;

    await uploadFilesToRepo(repo, files);

    setStatus(`Успешно загружено ${files.length} файлов!`, "success");
  } catch (err) {
    setStatus("Ошибка: " + err.message, "error");
  } finally {
    $("progress").style.display = "none";
  }
};

// Рекурсивный сбор всех файлов
async function collectAllFiles(dirHandle, path = "") {
  const files = [];

  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      files.push({
        path: path ? `${path}/${file.name}` : file.name,
        content: await file.arrayBuffer()
      });
    } else if (entry.kind === "directory") {
      const subFiles = await collectAllFiles(entry, path ? `${path}/${entry.name}` : entry.name);
      files.push(...subFiles);
    }
  }

  return files;
}

// Загрузка файлов через GitHub API (Contents API)
async function uploadFilesToRepo(repoFullName, files) {
  const token = (await chrome.storage.local.get("github_token")).github_token;
  const total = files.length;
  let done = 0;

  for (const file of files) {
    const { path, content } = file;

    const base64 = arrayBufferToBase64(content);

    // Проверяем, существует ли файл
    let sha = null;
    try {
      const getResp = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(path)}`, {
        headers: { "Authorization": `token ${token}` }
      });
      if (getResp.ok) {
        const data = await getResp.json();
        sha = data.sha;
      }
    } catch {}

    const payload = {
      message: `Добавлен/обновлён ${path} через расширение`,
      content: base64,
      sha // если есть — обновляем, если нет — создаём
    };

    const resp = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(`Не удалось загрузить ${path}: ${err.message}`);
    }

    done++;
    $("progress").value = Math.round((done / total) * 100);
    setStatus(`Загружено ${done}/${total} файлов...`);
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ======== События ========
$("login-btn").onclick = redirectToGitHubAuth;
$("refresh-repos").onclick = loadRepositories;

init();