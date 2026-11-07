"use client";

import {
  useEffect,
  useRef,
  useState,
  useId,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  List,
  ChevronRight,
  ShieldCheck,
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  FolderOpen,
  Layers3,
  LayoutGrid,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sprout,
  UploadCloud,
  Users,
  Video,
  X,
  Image as ImageIcon,
  CalendarDays,
  Trash2,
  Pencil,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { NETWORKS, MAX_UPLOAD } from "@/lib/domain";

type Profile = {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
};
type Channel = {
  id: string;
  profileId: string;
  platform: string;
  username: string | null;
  state: string;
  accountId: string | null;
};
type Media = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
};
type Post = {
  id: string;
  profileId: string;
  title: string;
  content: string;
  mediaId: string | null;
  platforms: string;
  status: string;
  scheduledFor: string | null;
  error: string | null;
};
type State = {
  profiles: Profile[];
  channels: Channel[];
  media: Media[];
  posts: Post[];
  configured: boolean;
};
const initial: State = {
  profiles: [],
  channels: [],
  media: [],
  posts: [],
  configured: false,
};
const names: Record<string, string> = {
  draft: "Черновик",
  sending: "Отправляется",
  uncertain: "Нужна проверка",
  scheduled: "Запланировано",
  published: "Опубликовано",
  failed: "Ошибка",
  partial: "Частично",
  processing: "В обработке",
};
const colors = ["#dce8c8", "#e4dcf1", "#f4dfca", "#d7e8ec", "#f0dce0"];
const date = (value: string) =>
  new Date(value).toLocaleString("ru-RU", {
    timeZone: "Asia/Qyzylorda",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
function Network({
  platform,
  small = false,
}: {
  platform: string;
  small?: boolean;
}) {
  const n = NETWORKS.find((n) => n.id === platform)!;
  return (
    <span
      className={`network network-${platform} ${small ? "small" : ""}`}
      title={n.name}
    >
      <img
        src={`/icons/${platform === "twitter" ? "x" : platform}.svg`}
        alt={n.name}
        width={20}
        height={20}
      />
    </span>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? "wide" : ""}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export default function Home() {
  const [state, setState] = useState<State>(initial);
  const [tab, setTab] = useState("profiles");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [profileModal, setProfileModal] = useState(false);
  const [detail, setDetail] = useState<Profile | null>(null);
  const [color, setColor] = useState(colors[0]);
  const [editor, setEditor] = useState<Partial<Post> | null>(null);
  const [schedule, setSchedule] = useState<Post | null>(null);
  const [preview, setPreview] = useState<Media | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadActive, setUploadActive] = useState(false);
  const [postFilter, setPostFilter] = useState("all");
  const [profileView, setProfileView] = useState("list");
  const [contentProfile, setContentProfile] = useState("all");
  const [deletePost, setDeletePost] = useState<Post | null>(null);
  const [uploadName, setUploadName] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  async function reload() {
    const r = await fetch("/api/workspace");
    const data = (await r.json()) as State & { error?: string };
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить данные.");
    setState(data);
    setLoading(false);
  }
  async function action(body: Record<string, unknown>) {
    const r = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as {
      error?: string;
      authUrl: string;
      id?: string;
    };
    if (!r.ok) throw new Error(data.error || "Не удалось выполнить действие.");
    return data;
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Что-то пошло не так.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void reload()
      .then(async () => {
        const params = new URLSearchParams(location.search);
        if (params.has("oauth")) {
          history.replaceState({}, "", "/");
          if (params.has("error")) {
            setError(
              "Авторизация не завершена. Повторите подключение и разрешите доступ к соцсети.",
            );
            return;
          }
          await action({ action: "sync" });
          await reload();
          setNotice("Статусы подключений обновлены.");
        }
      })
      .catch((e) => {
        setLoading(false);
        setError(e.message);
      });
  }, []);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  function navigate(value: string) {
    setTab(value);
    setQuery("");
    setFilter("all");
    setError("");
    history.replaceState({}, "", `/#${value}`);
    window.scrollTo({ top: 0 });
  }
  useEffect(() => {
    const initialTab = location.hash.slice(1);
    if (["profiles", "content", "library", "settings"].includes(initialTab))
      setTab(initialTab);
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (
        event.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) &&
        !element.isContentEditable &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  function compose(profileId?: string, mediaId?: string) {
    if (!state.profiles.length) {
      setProfileModal(true);
      setNotice("Сначала создайте профиль для публикации.");
      return;
    }
    setEditor({
      profileId: profileId || state.profiles[0].id,
      mediaId: mediaId || null,
      title: "",
      content: "",
      platforms: "[]",
    });
  }
  async function uploadFiles(files: FileList | File[]) {
    if (uploadActive) return;
    setError("");
    setUploadActive(true);
    try {
      for (const file of Array.from(files)) {
        if (
          file.size > MAX_UPLOAD ||
          ![
            "video/mp4",
            "video/quicktime",
            "image/jpeg",
            "image/png",
            "image/webp",
          ].includes(file.type)
        )
          throw new Error(
            `${file.name}: нужен MP4, MOV, JPG, PNG или WebP до 90 МБ.`,
          );
        setUploading(0);
        setUploadName(file.name);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/media");
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable)
              setUploading(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onerror = () =>
            reject(new Error("Связь прервалась. Повторите загрузку."));
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const uploaded = JSON.parse(xhr.responseText);
              setEditor((current) =>
                current ? { ...current, mediaId: uploaded.id } : null,
              );
              resolve();
            } else {
              try {
                reject(new Error(JSON.parse(xhr.responseText).error));
              } catch {
                reject(new Error("Не удалось загрузить файл."));
              }
            }
          };
          xhr.send(file);
        });
        await reload();
      }
      setNotice("Файлы добавлены в медиатеку.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки.");
    } finally {
      setUploadActive(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const connected = state.channels.filter((c) => c.state === "connected");
  const filteredProfiles = state.profiles.filter(
    (p) =>
      `${p.name} ${p.description}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "ready"
          ? connected.filter((c) => c.profileId === p.id).length === 2
          : connected.filter((c) => c.profileId === p.id).length < 2)),
  );
  const title = {
    profiles: "Профили",
    content: "Публикации",
    library: "Медиатека",
    settings: "Настройки",
  }[tab];
  const subtitle = {
    profiles: "Управляйте авторами, проектами и подключёнными соцсетями.",
    content: "Готовьте материалы и управляйте расписанием публикаций.",
    library: "Готовые видео и изображения для ваших публикаций.",
    settings: "Интеграции и параметры рабочего пространства.",
  }[tab];
  const draftCount = state.posts.filter((p) => p.status === "draft").length;
  const readyCount = state.profiles.filter(
    (p) => connected.filter((c) => c.profileId === p.id).length === 2,
  ).length;
  const visiblePosts = state.posts.filter(
    (p) =>
      (postFilter === "all" ||
        (postFilter === "attention"
          ? ["failed", "uncertain", "partial"].includes(p.status)
          : p.status === postFilter)) &&
      (contentProfile === "all" || p.profileId === contentProfile) &&
      `${p.title} ${p.content}`.toLowerCase().includes(query.toLowerCase()),
  );
  const visibleMedia = state.media.filter((m) =>
    m.name.toLowerCase().includes(query.toLowerCase()),
  );
  const search = (placeholder: string) => (
    <div className="search">
      <Search size={16} />
      <input
        ref={searchRef}
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query ? (
        <button
          className="clear-search"
          aria-label="Очистить поиск"
          onClick={() => {
            setQuery("");
            searchRef.current?.focus();
          }}
        >
          <X size={14} />
        </button>
      ) : (
        <kbd>/</kbd>
      )}
    </div>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Ferma — главная">
          <span className="brand-icon">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 19V5h13M6 12h10"
                stroke="currentColor"
                strokeWidth="3"
              />
              <path d="M11 19v-3h8" stroke="currentColor" strokeWidth="3" />
            </svg>
          </span>
          ferma<span className="brand-label">WORKSPACE</span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">F</span>
          <div>
            <strong>Моя ферма</strong>
            <small>Личное пространство</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <div className="nav-label">Рабочее пространство</div>
        <nav aria-label="Основная навигация">
          {[
            {
              id: "profiles",
              icon: Users,
              text: "Профили",
              count: state.profiles.length,
            },
            {
              id: "content",
              icon: CalendarDays,
              text: "Публикации",
              count: state.posts.length,
            },
            {
              id: "library",
              icon: FolderOpen,
              text: "Медиатека",
              count: state.media.length,
            },
          ].map((n) => (
            <button
              aria-current={tab === n.id ? "page" : undefined}
              className={`nav-item ${tab === n.id ? "active" : ""}`}
              key={n.id}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={18} />
              <span>{n.text}</span>
              <small>{n.count}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="sidebar-connection"
            onClick={() => navigate("settings")}
          >
            <span
              className={`integration-dot ${state.configured ? "on" : ""}`}
            />
            <div>
              <strong>Zernio</strong>
              <small>
                {state.configured
                  ? "Интеграция настроена"
                  : "Ожидает подключения"}
              </small>
            </div>
            <ChevronRight size={14} />
          </button>
          <button
            aria-current={tab === "settings" ? "page" : undefined}
            className={`nav-item ${tab === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} />
            <span>Настройки</span>
          </button>
          <div className="owner">
            <span className="owner-avatar">F</span>
            <div>
              <strong>Моя ферма</strong>
              <small>Личный аккаунт</small>
            </div>
            <span className="owner-badge">Владелец</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span className="mobile-brand">ferma</span>
            <span className="breadcrumb">Моя ферма</span>
            <ChevronRight size={13} />
            <span>{title}</span>
          </div>
          <div className="topbar-right">
            <span className="timezone">
              <Clock3 size={14} />
              Кызылорда <span>UTC+5</span>
            </span>
            <span className="top-avatar" title="Личное пространство">
              F
            </span>
          </div>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <div className="title-line">
                <h1>{title}</h1>
                {tab !== "settings" && (
                  <span className="title-count">
                    {tab === "profiles"
                      ? state.profiles.length
                      : tab === "content"
                        ? state.posts.length
                        : state.media.length}
                  </span>
                )}
              </div>
              <p>{subtitle}</p>
            </div>
            {tab !== "settings" && (
              <div className="heading-actions">
                {tab === "profiles" && state.profiles.length > 0 && (
                  <button
                    className="secondary"
                    disabled={busy || !state.configured}
                    title={
                      state.configured
                        ? "Обновить подключения"
                        : "Сначала подключите Zernio"
                    }
                    onClick={() =>
                      run(async () => {
                        await action({ action: "sync" });
                        await reload();
                        setNotice("Статусы обновлены.");
                      })
                    }
                  >
                    <RefreshCw size={16} />
                    Обновить
                  </button>
                )}
                <button
                  className="primary"
                  onClick={() =>
                    tab === "profiles"
                      ? setProfileModal(true)
                      : tab === "library"
                        ? fileRef.current?.click()
                        : compose()
                  }
                  disabled={uploadActive}
                >
                  {tab === "library" ? (
                    <UploadCloud size={17} />
                  ) : (
                    <Plus size={17} />
                  )}{" "}
                  {tab === "profiles"
                    ? "Новый профиль"
                    : tab === "library"
                      ? "Загрузить файлы"
                      : "Новая публикация"}
                </button>
              </div>
            )}
          </div>
          {error && (
            <div className="message error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Закрыть ошибку"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              <span>
                <Check size={15} />
              </span>
              {notice}
              <button
                aria-label="Закрыть уведомление"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <input
            hidden
            ref={fileRef}
            type="file"
            multiple
            accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp"
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
            }}
          />
          {uploadActive && (
            <div className="upload-progress" role="status">
              <Loader2 className="spin" size={18} />
              <div>
                <strong>{uploadName}</strong>
                <span>Загрузка · {uploading}%</span>
              </div>
              <progress value={uploading} max={100} />
            </div>
          )}
          {loading ? (
            <div className="loading">
              <Loader2 className="spin" size={20} />
              Загружаем пространство…
            </div>
          ) : (
            <>
              {tab === "profiles" && (
                <>
                  {!state.configured && (
                    <div className="integration-banner">
                      <Link2 size={18} />
                      <div>
                        <strong>Подключите Zernio</strong>
                        <span>
                          {" "}
                          для авторизации соцсетей и публикации контента.
                        </span>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => navigate("settings")}
                      >
                        Настроить <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                  {state.profiles.length > 0 && (
                    <div className="summary-strip">
                      <div>
                        <span>Готовы к работе</span>
                        <strong>
                          {readyCount}
                          <small> / {state.profiles.length}</small>
                        </strong>
                      </div>
                      <div>
                        <span>Подключено соцсетей</span>
                        <strong>
                          {connected.length}
                          <small> / {state.profiles.length * 2}</small>
                        </strong>
                      </div>
                      <div>
                        <span>По расписанию</span>
                        <strong>
                          {
                            state.posts.filter((p) => p.status === "scheduled")
                              .length
                          }
                        </strong>
                      </div>
                      <div>
                        <span>Черновики</span>
                        <strong>{draftCount}</strong>
                      </div>
                    </div>
                  )}
                  {!state.profiles.length && (
                    <div className="onboarding">
                      <div className="onboarding-title">
                        <span className="onboarding-label">Быстрый старт</span>
                        <h2>Настройте рабочее пространство</h2>
                        <p>Три шага до первой публикации.</p>
                      </div>
                      <div className="onboarding-steps">
                        <button onClick={() => setProfileModal(true)}>
                          <span className="step-number">1</span>
                          <div>
                            <strong>Создайте профиль</strong>
                            <p>Для автора, бренда или проекта</p>
                          </div>
                          <ArrowUpRight size={16} />
                        </button>
                        <button onClick={() => navigate("settings")}>
                          <span className="step-number">2</span>
                          <div>
                            <strong>Подключите соцсети</strong>
                            <p>До двух на каждый профиль</p>
                          </div>
                          <ArrowUpRight size={16} />
                        </button>
                        <button onClick={() => navigate("library")}>
                          <span className="step-number">3</span>
                          <div>
                            <strong>Загрузите контент</strong>
                            <p>Видео и изображения для публикаций</p>
                          </div>
                          <ArrowUpRight size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                  <section className="collection" aria-label="Список профилей">
                    <div className="collection-toolbar">
                      <div className="tabs" aria-label="Фильтр профилей">
                        {[
                          {
                            id: "all",
                            text: "Все профили",
                            count: state.profiles.length,
                          },
                          {
                            id: "ready",
                            text: "Подключены",
                            count: readyCount,
                          },
                          {
                            id: "incomplete",
                            text: "Нужна настройка",
                            count: state.profiles.length - readyCount,
                          },
                        ].map((t) => (
                          <button
                            key={t.id}
                            aria-pressed={filter === t.id}
                            className={filter === t.id ? "selected" : ""}
                            onClick={() => setFilter(t.id)}
                          >
                            {t.text}
                            <span>{t.count}</span>
                          </button>
                        ))}
                      </div>
                      <div className="toolbar-right">
                        {search("Поиск профиля")}
                        <div className="view-switch" aria-label="Вид профилей">
                          <button
                            aria-label="Список"
                            aria-pressed={profileView === "list"}
                            className={profileView === "list" ? "active" : ""}
                            onClick={() => setProfileView("list")}
                          >
                            <List size={16} />
                          </button>
                          <button
                            aria-label="Карточки"
                            aria-pressed={profileView === "grid"}
                            className={profileView === "grid" ? "active" : ""}
                            onClick={() => setProfileView("grid")}
                          >
                            <LayoutGrid size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                    {filteredProfiles.length ? (
                      profileView === "list" ? (
                        <div className="profile-table">
                          <div className="profile-table-head">
                            <span>Профиль</span>
                            <span>Социальные сети</span>
                            <span>Статус</span>
                            <span>Контент</span>
                            <span />
                          </div>
                          {filteredProfiles.map((p) => {
                            const cs = state.channels.filter(
                              (c) => c.profileId === p.id,
                            );
                            const count = cs.filter(
                              (c) => c.state === "connected",
                            ).length;
                            return (
                              <article className="profile-row" key={p.id}>
                                <button
                                  className="profile-identity"
                                  onClick={() => setDetail(p)}
                                >
                                  <span
                                    className="profile-avatar"
                                    style={{ background: p.color }}
                                  >
                                    {p.name.slice(0, 2).toUpperCase()}
                                  </span>
                                  <span>
                                    <strong>{p.name}</strong>
                                    <small>
                                      {p.description || "Без описания"}
                                    </small>
                                  </span>
                                </button>
                                <div className="row-networks">
                                  {[0, 1].map((slot) =>
                                    cs[slot] ? (
                                      <button
                                        key={slot}
                                        className="row-channel"
                                        onClick={() => setDetail(p)}
                                        title={
                                          cs[slot].username ||
                                          NETWORKS.find(
                                            (n) => n.id === cs[slot].platform,
                                          )?.name
                                        }
                                      >
                                        <Network
                                          platform={cs[slot].platform}
                                          small
                                        />
                                        <span>
                                          {
                                            NETWORKS.find(
                                              (n) => n.id === cs[slot].platform,
                                            )?.name
                                          }
                                        </span>
                                      </button>
                                    ) : (
                                      <button
                                        key={slot}
                                        className="empty-channel"
                                        aria-label={`Подключить соцсеть ${slot + 1} для ${p.name}`}
                                        onClick={() => setDetail(p)}
                                      >
                                        <Plus size={14} />
                                      </button>
                                    ),
                                  )}
                                </div>
                                <span
                                  className={`pill ${count === 2 ? "success" : count ? "progress" : "neutral"}`}
                                >
                                  <span className="status-dot" />
                                  {count === 2
                                    ? "Подключён"
                                    : count
                                      ? `${count} из 2 подключено`
                                      : "Не подключён"}
                                </span>
                                <button
                                  className="content-count"
                                  onClick={() => {
                                    navigate("content");
                                    setContentProfile(p.id);
                                  }}
                                >
                                  <FileText size={15} />
                                  {
                                    state.posts.filter(
                                      (t) => t.profileId === p.id,
                                    ).length
                                  }
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={`Открыть профиль ${p.name}`}
                                  onClick={() => setDetail(p)}
                                >
                                  <ChevronRight size={17} />
                                </button>
                              </article>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="profile-grid">
                          {filteredProfiles.map((p) => {
                            const cs = state.channels.filter(
                              (c) => c.profileId === p.id,
                            );
                            return (
                              <article key={p.id} className="profile-card">
                                <div className="profile-card-top">
                                  <span
                                    className="profile-avatar"
                                    style={{ background: p.color }}
                                  >
                                    {p.name.slice(0, 2).toUpperCase()}
                                  </span>
                                  <button
                                    className="icon-button"
                                    aria-label={`Открыть профиль ${p.name}`}
                                    onClick={() => setDetail(p)}
                                  >
                                    <ArrowUpRight size={17} />
                                  </button>
                                </div>
                                <h3>{p.name}</h3>
                                <p>{p.description || "Без описания"}</p>
                                <div className="profile-slots">
                                  {[0, 1].map((_, i) =>
                                    cs[i] ? (
                                      <button
                                        key={i}
                                        className="channel-slot"
                                        onClick={() => setDetail(p)}
                                      >
                                        <Network
                                          platform={cs[i].platform}
                                          small
                                        />
                                        <span>
                                          {cs[i].username
                                            ? `@${cs[i].username.replace(/^@/, "")}`
                                            : NETWORKS.find(
                                                (n) => n.id === cs[i].platform,
                                              )?.name}
                                        </span>
                                        {cs[i].state === "connected" ? (
                                          <Check size={14} />
                                        ) : (
                                          <Clock3 size={14} />
                                        )}
                                      </button>
                                    ) : (
                                      <button
                                        key={i}
                                        className="channel-slot empty-slot"
                                        onClick={() => setDetail(p)}
                                      >
                                        <Plus size={15} />
                                        Подключить соцсеть
                                      </button>
                                    ),
                                  )}
                                </div>
                                <footer>
                                  <span>
                                    <FileText size={14} />
                                    {
                                      state.posts.filter(
                                        (t) => t.profileId === p.id,
                                      ).length
                                    }{" "}
                                    публикаций
                                  </span>
                                  <button
                                    className="text-button"
                                    onClick={() => compose(p.id)}
                                  >
                                    Добавить контент <Plus size={14} />
                                  </button>
                                </footer>
                              </article>
                            );
                          })}
                        </div>
                      )
                    ) : (
                      <div className="empty-main">
                        <span className="empty-icon">
                          {state.profiles.length ? (
                            <Search size={25} />
                          ) : (
                            <Users size={26} />
                          )}
                        </span>
                        <h2>
                          {state.profiles.length
                            ? "Ничего не найдено"
                            : "Пока нет профилей"}
                        </h2>
                        <p>
                          {state.profiles.length
                            ? "Измените поисковый запрос или выберите другой фильтр."
                            : "Создайте профиль, чтобы подключить соцсети и назначать ему контент."}
                        </p>
                        {state.profiles.length ? (
                          <button
                            className="secondary"
                            onClick={() => {
                              setQuery("");
                              setFilter("all");
                            }}
                          >
                            Сбросить фильтры
                          </button>
                        ) : (
                          <button
                            className="primary"
                            onClick={() => setProfileModal(true)}
                          >
                            <Plus size={16} />
                            Создать профиль
                          </button>
                        )}
                      </div>
                    )}
                    <footer className="collection-footer">
                      <span>
                        {state.profiles.length
                          ? `Показано ${filteredProfiles.length} из ${state.profiles.length}`
                          : "Поддерживаемые соцсети"}
                      </span>
                      <div className="supported-networks">
                        {NETWORKS.map((n) => (
                          <Network key={n.id} platform={n.id} small />
                        ))}
                      </div>
                      <span className="slot-hint">2 соцсети на профиль</span>
                    </footer>
                  </section>
                </>
              )}
              {tab === "library" && (
                <>
                  <div
                    className={`dropzone ${uploadActive ? "uploading" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.add("drag-over");
                    }}
                    onDragLeave={(e) =>
                      e.currentTarget.classList.remove("drag-over")
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("drag-over");
                      void uploadFiles(e.dataTransfer.files);
                    }}
                  >
                    <span className="upload-icon">
                      <UploadCloud size={25} />
                    </span>
                    <div>
                      <h2>Перетащите файлы для загрузки</h2>
                      <p>
                        Или{" "}
                        <button
                          className="inline-button"
                          onClick={() => fileRef.current?.click()}
                          disabled={uploadActive}
                        >
                          выберите на компьютере
                        </button>
                      </p>
                    </div>
                    <span className="upload-formats">
                      MP4, MOV, JPG, PNG, WebP
                      <br />
                      <span>До 90 МБ на файл</span>
                    </span>
                  </div>
                  <div className="section-bar">
                    <div className="section-title-inline">
                      <h2>Все материалы</h2>
                      <span className="title-count">{state.media.length}</span>
                    </div>
                    {search("Поиск файла")}
                  </div>
                  {visibleMedia.length ? (
                    <div className="media-grid">
                      {visibleMedia.map((m) => (
                        <article className="media-card" key={m.id}>
                          <button
                            className="media-preview"
                            onClick={() => setPreview(m)}
                            aria-label={`Просмотр ${m.name}`}
                          >
                            {m.type.startsWith("image") ? (
                              <img
                                loading="lazy"
                                src={`/api/media?id=${m.id}`}
                                alt={m.name}
                              />
                            ) : (
                              <>
                                <Video size={34} />
                                <span>Видео</span>
                              </>
                            )}
                            <span className="media-type">
                              {m.name.split(".").pop()?.toUpperCase()}
                            </span>
                          </button>
                          <div className="media-info">
                            <h3 title={m.name}>{m.name}</h3>
                            <small>
                              {(m.size / 1024 / 1024).toFixed(1)} МБ
                              <span>·</span>
                              {date(m.createdAt)}
                            </small>
                            <button
                              className="secondary"
                              onClick={() => compose(undefined, m.id)}
                            >
                              <Plus size={15} />В публикацию
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="simple-empty">
                      <span className="empty-icon">
                        <FolderOpen size={26} />
                      </span>
                      <h2>
                        {state.media.length
                          ? "Файлы не найдены"
                          : "Медиатека пока пустая"}
                      </h2>
                      <p>
                        {state.media.length
                          ? "Попробуйте другое название файла."
                          : "Загрузите готовые материалы — они будут доступны при создании публикации."}
                      </p>
                    </div>
                  )}
                </>
              )}
              {tab === "content" && (
                <>
                  <div className="content-toolbar">
                    <div className="tabs" aria-label="Статус публикаций">
                      {[
                        { id: "all", text: "Все", count: state.posts.length },
                        { id: "draft", text: "Черновики", count: draftCount },
                        {
                          id: "scheduled",
                          text: "В расписании",
                          count: state.posts.filter(
                            (p) => p.status === "scheduled",
                          ).length,
                        },
                        {
                          id: "published",
                          text: "Опубликованы",
                          count: state.posts.filter(
                            (p) => p.status === "published",
                          ).length,
                        },
                        {
                          id: "attention",
                          text: "Требуют внимания",
                          count: state.posts.filter((p) =>
                            ["failed", "uncertain", "partial"].includes(
                              p.status,
                            ),
                          ).length,
                        },
                      ]
                        .filter((f) => f.id !== "attention" || f.count)
                        .map((f) => (
                          <button
                            key={f.id}
                            aria-pressed={postFilter === f.id}
                            className={postFilter === f.id ? "selected" : ""}
                            onClick={() => setPostFilter(f.id)}
                          >
                            {f.text}
                            <span>{f.count}</span>
                          </button>
                        ))}
                    </div>
                  </div>
                  <div className="section-bar content-filters">
                    <div className="toolbar-left">
                      {search("Поиск публикации")}
                      <select
                        className="filter-select"
                        aria-label="Фильтр по профилю"
                        value={contentProfile}
                        onChange={(e) => setContentProfile(e.target.value)}
                      >
                        <option value="all">Все профили</option>
                        {state.profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      className="secondary"
                      disabled={busy || !state.configured}
                      title={
                        !state.configured
                          ? "Сначала подключите Zernio"
                          : "Получить актуальные статусы"
                      }
                      onClick={() =>
                        run(async () => {
                          await action({ action: "sync" });
                          await reload();
                          setNotice("Статусы обновлены.");
                        })
                      }
                    >
                      <RefreshCw size={15} />
                      Обновить
                    </button>
                  </div>
                  <div className="post-list">
                    {visiblePosts.map((p) => (
                      <article className="post-card" key={p.id}>
                        <div className="post-art">
                          {p.mediaId ? (
                            state.media
                              .find((m) => m.id === p.mediaId)
                              ?.type.startsWith("image") ? (
                              <img src={`/api/media?id=${p.mediaId}`} alt="" />
                            ) : (
                              <Video size={22} />
                            )
                          ) : (
                            <FileText size={22} />
                          )}
                        </div>
                        <div className="post-info">
                          <h3>{p.title}</h3>
                          <p>
                            {
                              state.profiles.find((pr) => pr.id === p.profileId)
                                ?.name
                            }
                            <span>·</span>
                            {p.scheduledFor ? date(p.scheduledFor) : "Без даты"}
                          </p>
                          {p.error && (
                            <small className="error-text">{p.error}</small>
                          )}
                        </div>
                        <div className="post-networks">
                          {JSON.parse(p.platforms).map((n: string) => (
                            <Network key={n} platform={n} small />
                          ))}
                        </div>
                        <span
                          className={`pill ${p.status === "published" ? "success" : p.status === "scheduled" ? "progress" : ["failed", "uncertain", "partial"].includes(p.status) ? "danger" : "neutral"}`}
                        >
                          <span className="status-dot" />
                          {names[p.status] || p.status}
                        </span>
                        {p.status === "draft" && (
                          <div className="post-actions">
                            <button
                              className="icon-button"
                              title="Редактировать"
                              aria-label={`Редактировать ${p.title}`}
                              onClick={() => setEditor(p)}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="secondary"
                              onClick={() => setSchedule(p)}
                            >
                              Запланировать
                            </button>
                            <button
                              className="icon-button"
                              title="Удалить черновик"
                              aria-label={`Удалить черновик ${p.title}`}
                              disabled={busy}
                              onClick={() => setDeletePost(p)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        )}
                        {p.status === "uncertain" && (
                          <button
                            className="secondary"
                            onClick={() => setSchedule(p)}
                          >
                            Проверить отправку
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                  {!visiblePosts.length && (
                    <div className="simple-empty content-empty">
                      <span className="empty-icon">
                        <CalendarDays size={26} />
                      </span>
                      <h2>
                        {state.posts.length
                          ? "Нет публикаций по этим условиям"
                          : "Пока нет публикаций"}
                      </h2>
                      <p>
                        {state.posts.length
                          ? "Измените статус, профиль или поисковый запрос."
                          : "Добавьте материал, выберите профиль и сохраните черновик."}
                      </p>
                      {state.posts.length ? (
                        <button
                          className="secondary"
                          onClick={() => {
                            setQuery("");
                            setContentProfile("all");
                            setPostFilter("all");
                          }}
                        >
                          Сбросить фильтры
                        </button>
                      ) : (
                        <button className="primary" onClick={() => compose()}>
                          <Plus size={16} />
                          Создать публикацию
                        </button>
                      )}
                    </div>
                  )}
                  <div className="page-footnote">
                    <span>
                      <Clock3 size={14} />
                      Время указано по Кызылорде, UTC+5
                    </span>
                    <span>Публикация через Zernio</span>
                  </div>
                </>
              )}
              {tab === "settings" && (
                <div className="settings-layout">
                  <section className="settings-card">
                    <div className="settings-card-heading">
                      <span className="settings-service-icon">
                        <Link2 size={23} />
                      </span>
                      <div>
                        <h2>Zernio</h2>
                        <p>Подключение и публикация в соцсети</p>
                      </div>
                      <span
                        className={`pill ${state.configured ? "success" : "neutral"}`}
                      >
                        <span className="status-dot" />
                        {state.configured ? "Настроено" : "Не подключено"}
                      </span>
                    </div>
                    <div className="settings-body">
                      <div className="network-list">
                        {NETWORKS.map((n) => (
                          <div key={n.id}>
                            <Network platform={n.id} />
                            <span>{n.name}</span>
                          </div>
                        ))}
                      </div>
                      <div className="settings-divider" />
                      <h3>
                        {state.configured
                          ? "Управление подключением"
                          : "Как подключить"}
                      </h3>
                      <ol className="steps">
                        <li>
                          <span>1</span>
                          <div>
                            <strong>Создайте API-ключ</strong>
                            <p>
                              В личном кабинете Zernio перейдите в раздел API
                              keys.
                            </p>
                            <a
                              href="https://zernio.com"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Перейти в Zernio <ArrowUpRight size={14} />
                            </a>
                          </div>
                        </li>
                        <li>
                          <span>2</span>
                          <div>
                            <strong>Добавьте ключ на сервер</strong>
                            <p>
                              Задайте переменную <code>ZERNIO_API_KEY</code> в
                              настройках размещения и примените новое окружение.
                            </p>
                            <details>
                              <summary>Для локального запуска</summary>
                              <p>
                                Добавьте ключ в файл <code>.dev.vars</code> и
                                перезапустите сервер.
                              </p>
                            </details>
                          </div>
                        </li>
                        <li>
                          <span>3</span>
                          <div>
                            <strong>Авторизуйте соцсети</strong>
                            <p>
                              Откройте профиль и выберите до двух соцсетей.
                              Авторизация пройдёт на стороне сервиса.
                            </p>
                            <button
                              className="inline-button"
                              onClick={() => navigate("profiles")}
                            >
                              Перейти к профилям <ArrowRight size={14} />
                            </button>
                          </div>
                        </li>
                      </ol>
                    </div>
                    <footer className="settings-footer">
                      <span>
                        <ShieldCheck size={15} />
                        Ключ хранится только на сервере
                      </span>
                      <button
                        className="secondary"
                        disabled={busy || !state.configured}
                        onClick={() =>
                          run(async () => {
                            await action({ action: "sync" });
                            await reload();
                            setNotice("Подключение проверено.");
                          })
                        }
                      >
                        <RefreshCw size={15} />
                        Проверить
                      </button>
                    </footer>
                  </section>
                  <div className="settings-aside">
                    <section className="settings-card">
                      <div className="settings-body">
                        <h3>Рабочее пространство</h3>
                        <dl>
                          <div>
                            <dt>Название</dt>
                            <dd>Моя ферма</dd>
                          </div>
                          <div>
                            <dt>Часовой пояс</dt>
                            <dd>Кызылорда · UTC+5</dd>
                          </div>
                          <div>
                            <dt>Соцсети на профиль</dt>
                            <dd>До 2 подключений</dd>
                          </div>
                          <div>
                            <dt>Загрузка файлов</dt>
                            <dd>До 90 МБ</dd>
                          </div>
                          <div>
                            <dt>Доступ</dt>
                            <dd>
                              <ShieldCheck size={14} />
                              Только владелец
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </section>
                    <div className="settings-note">
                      <CircleHelp size={17} />
                      <p>
                        Лимиты подключений и публикаций зависят от вашего тарифа
                        Zernio и правил соцсетей.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {profileModal && (
        <Modal
          title="Новый профиль"
          close={() => !busy && setProfileModal(false)}
        >
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void run(async () => {
                await action({
                  action: "profile",
                  name: data.get("name"),
                  description: data.get("description"),
                  color,
                });
                await reload();
                setProfileModal(false);
                setNotice("Профиль создан. Теперь можно подключить соцсети.");
              });
            }}
          >
            <div className="form-body">
              <p className="muted">
                Отдельный профиль для каждого автора, бренда или проекта.
              </p>
              <label>
                Название профиля
                <input
                  autoFocus
                  name="name"
                  required
                  maxLength={80}
                  placeholder="Например, Истории о путешествиях"
                />
              </label>
              <label>
                Описание <span className="optional">необязательно</span>
                <textarea
                  name="description"
                  rows={3}
                  maxLength={300}
                  placeholder="О чём проект и для кого ваш контент"
                />
              </label>
              <label>Цвет профиля</label>
              <div className="color-picker">
                {colors.map((c) => (
                  <button
                    type="button"
                    key={c}
                    aria-label={`Цвет ${c}`}
                    className={color === c ? "chosen" : ""}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                  >
                    {color === c && <Check size={17} />}
                  </button>
                ))}
              </div>
              <div className="form-note">
                <Link2 size={17} />К профилю можно подключить две соцсети.
              </div>
              {error && (
                <div className="error-text" role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                onClick={() => setProfileModal(false)}
                disabled={busy}
              >
                Отмена
              </button>
              <button className="primary" disabled={busy}>
                {busy && <Loader2 size={16} className="spin" />}Создать профиль
              </button>
            </div>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal title={detail.name} close={() => !busy && setDetail(null)}>
          <div className="form-body">
            <div className="detail-intro">
              <span
                className="profile-avatar"
                style={{ background: detail.color }}
              >
                {detail.name.slice(0, 2).toUpperCase()}
              </span>
              <p>
                {detail.description || "Выберите соцсети для этого профиля."}
              </p>
            </div>
            <div className="section-title">
              <h3>Социальные сети</h3>
              <span>
                {state.channels.filter((c) => c.profileId === detail.id).length}{" "}
                / 2 слота
              </span>
            </div>
            <div className="connect-list">
              {NETWORKS.map((n) => {
                const c = state.channels.find(
                  (c) => c.profileId === detail.id && c.platform === n.id,
                );
                const full =
                  state.channels.filter((c) => c.profileId === detail.id)
                    .length >= 2;
                return (
                  <div className="connect-row" key={n.id}>
                    <Network platform={n.id} />
                    <div>
                      <strong>{n.name}</strong>
                      <small>
                        {c?.username
                          ? `@${c.username.replace(/^@/, "")}`
                          : c
                            ? "Ожидает авторизации"
                            : "Не подключено"}
                      </small>
                    </div>
                    <button
                      className="secondary"
                      disabled={busy || !state.configured || (!c && full)}
                      onClick={() =>
                        run(async () => {
                          const data = await action({
                            action: "connect",
                            profileId: detail.id,
                            platform: n.id,
                          });
                          window.location.assign(data.authUrl);
                        })
                      }
                    >
                      {c?.state === "connected"
                        ? "Переподключить"
                        : c
                          ? "Продолжить"
                          : "Подключить"}
                    </button>
                    {c && !c.accountId && (
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Отменить подключение ${n.name}`}
                        onClick={() =>
                          run(async () => {
                            await action({
                              action: "cancelConnection",
                              channelId: c.id,
                            });
                            await reload();
                          })
                        }
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {!state.configured && (
              <div className="form-note">
                <AlertCircle size={18} />
                Сначала подключите Zernio.{" "}
                <button
                  className="inline-button"
                  onClick={() => {
                    setDetail(null);
                    navigate("settings");
                  }}
                >
                  Открыть настройки
                </button>
              </div>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy || !state.configured}
              onClick={() =>
                run(async () => {
                  await action({ action: "sync" });
                  await reload();
                })
              }
            >
              <RefreshCw size={15} />
              Обновить
            </button>
            <button
              className="primary"
              onClick={() => {
                compose(detail.id);
                setDetail(null);
              }}
            >
              <Plus size={16} />
              Добавить контент
            </button>
          </div>
        </Modal>
      )}
      {editor && (
        <Modal
          title={editor.id ? "Редактировать черновик" : "Новая публикация"}
          close={() => !busy && setEditor(null)}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await action({
                  ...editor,
                  action: "draft",
                  platforms: JSON.parse(editor.platforms || "[]"),
                });
                await reload();
                setEditor(null);
                setTab("content");
                setNotice("Черновик сохранён.");
              });
            }}
          >
            <div className="form-body">
              <div className="form-columns">
                <div>
                  <label>
                    Профиль
                    <select
                      value={editor.profileId}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          profileId: e.target.value,
                          platforms: "[]",
                        })
                      }
                    >
                      {state.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Название
                    <input
                      required
                      maxLength={100}
                      value={editor.title}
                      onChange={(e) =>
                        setEditor({ ...editor, title: e.target.value })
                      }
                      placeholder="Название публикации / видео"
                    />
                  </label>
                  <label>
                    Подпись
                    <textarea
                      rows={5}
                      maxLength={5000}
                      value={editor.content}
                      onChange={(e) =>
                        setEditor({ ...editor, content: e.target.value })
                      }
                      placeholder="Текст, который увидит ваша аудитория"
                    />
                  </label>
                  <span className="char-count">
                    {editor.content?.length || 0} символов
                  </span>
                </div>
                <div>
                  <label>
                    Материал из медиатеки
                    <select
                      value={editor.mediaId || ""}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          mediaId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">Без файла</option>
                      {state.media.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="editor-upload"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploadActive}
                  >
                    <UploadCloud size={26} />
                    <strong>
                      {uploadActive
                        ? `Загрузка ${uploading}%`
                        : "Загрузить новый файл"}
                    </strong>
                    <small>Файл добавится в публикацию автоматически</small>
                  </button>
                  <label>Куда опубликовать</label>
                  <div className="target-list">
                    {NETWORKS.map((n) => {
                      const checked = JSON.parse(
                        editor.platforms || "[]",
                      ).includes(n.id);
                      const available = state.channels.some(
                        (c) =>
                          c.profileId === editor.profileId &&
                          c.platform === n.id &&
                          c.state === "connected",
                      );
                      return (
                        <label
                          key={n.id}
                          className={`target ${!available ? "unavailable" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!available}
                            onChange={() => {
                              const arr = JSON.parse(editor.platforms || "[]");
                              setEditor({
                                ...editor,
                                platforms: JSON.stringify(
                                  checked
                                    ? arr.filter((v: string) => v !== n.id)
                                    : [...arr, n.id],
                                ),
                              });
                            }}
                          />
                          <Network platform={n.id} small />
                          <span>{n.name}</span>
                          {!available && <small>не подключено</small>}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="form-note">
                <FileText size={17} />
                Черновик можно сохранить до подключения соцсетей. Время выхода
                выбирается отдельно.
              </div>
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                Отмена
              </button>
              <button className="primary" disabled={busy || uploadActive}>
                {busy && <Loader2 size={16} className="spin" />}Сохранить
                черновик
              </button>
            </div>
          </form>
        </Modal>
      )}
      {schedule && (
        <Modal
          title="Запланировать публикацию"
          close={() => !busy && setSchedule(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(async () => {
                const value = String(form.get("date"));
                await action({
                  action: "schedule",
                  id: schedule.id,
                  scheduledFor:
                    schedule.status === "uncertain"
                      ? schedule.scheduledFor
                      : `${value}:00+05:00`,
                });
                await reload();
                setSchedule(null);
                setNotice("Публикация передана в расписание Zernio.");
              });
            }}
          >
            <div className="form-body">
              <div className="schedule-summary">
                <CalendarDays size={24} />
                <div>
                  <strong>{schedule.title}</strong>
                  <p>
                    {
                      state.profiles.find((p) => p.id === schedule.profileId)
                        ?.name
                    }
                  </p>
                </div>
              </div>
              <label>
                Дата и время · Кызылорда (UTC+5)
                <input
                  required
                  name="date"
                  type="datetime-local"
                  min={new Date(Date.now() + 5 * 3600000 + 120000)
                    .toISOString()
                    .slice(0, 16)}
                  disabled={schedule.status === "uncertain"}
                />
              </label>
              {!state.configured && (
                <div className="form-note">
                  <AlertCircle size={17} />
                  <span>Для планирования подключите Zernio в настройках.</span>
                  <button
                    type="button"
                    className="inline-button"
                    onClick={() => {
                      setSchedule(null);
                      navigate("settings");
                    }}
                  >
                    Настроить
                  </button>
                </div>
              )}
              <p className="muted">
                В назначенное время Zernio отправит материал в выбранные
                соцсети. Ограничения формата и доступов проверяются сервисом.
              </p>
              {schedule.status === "uncertain" && (
                <div className="form-note">
                  Повторяем исходный запрос с тем же ключом. Содержимое и время
                  не меняются.
                </div>
              )}
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                onClick={() => setSchedule(null)}
                disabled={busy}
              >
                Отмена
              </button>
              <button className="primary" disabled={busy || !state.configured}>
                {busy ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <CalendarDays size={16} />
                )}{" "}
                {busy ? "Отправляем…" : "Запланировать"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deletePost && (
        <Modal
          title="Удалить черновик?"
          close={() => !busy && setDeletePost(null)}
        >
          <div className="form-body">
            <p className="muted">
              Черновик «{deletePost.title}» будет удалён. Исходный файл
              останется в медиатеке.
            </p>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDeletePost(null)}
            >
              Отмена
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await action({ action: "deleteDraft", id: deletePost.id });
                  await reload();
                  setDeletePost(null);
                  setNotice("Черновик удалён.");
                })
              }
            >
              Удалить черновик
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.name} close={() => setPreview(null)} wide>
          <div className="preview-body">
            {preview.type.startsWith("video") ? (
              <video controls src={`/api/media?id=${preview.id}`} />
            ) : (
              <img src={`/api/media?id=${preview.id}`} alt={preview.name} />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
