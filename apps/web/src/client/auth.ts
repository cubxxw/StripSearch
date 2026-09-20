import type { SessionUser } from '../shared/types.js';
import { ApiClient, ApiError } from './api.js';
import { byId, setText } from './dom.js';

export type AuthMode = 'signin' | 'signup';

export interface AuthController {
  open(mode: AuthMode, onSuccess: (user: SessionUser) => void): void;
  close(): void;
  isOpen(): boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthController(api: ApiClient): AuthController {
  const dialog = byId<HTMLDialogElement>('auth-dialog');
  const form = byId<HTMLFormElement>('auth-form');
  const title = byId<HTMLHeadingElement>('auth-title');
  const nameField = byId<HTMLDivElement>('auth-name-field');
  const nameInput = byId<HTMLInputElement>('auth-name');
  const emailInput = byId<HTMLInputElement>('auth-email');
  const passwordInput = byId<HTMLInputElement>('auth-password');
  const nameError = byId<HTMLElement>('auth-name-error');
  const emailError = byId<HTMLElement>('auth-email-error');
  const passwordError = byId<HTMLElement>('auth-password-error');
  const status = byId<HTMLElement>('auth-status');
  const submit = byId<HTMLButtonElement>('auth-submit');
  const disclosure = byId<HTMLElement>('auth-disclosure');
  const toggle = byId<HTMLButtonElement>('toggle-password');
  const tabSignin = byId<HTMLButtonElement>('tab-signin');
  const tabSignup = byId<HTMLButtonElement>('tab-signup');

  let mode: AuthMode = 'signin';
  let onSuccess: (user: SessionUser) => void = () => undefined;
  let openEpoch = 0;
  let submitting = false;

  function setSubmitting(next: boolean): void {
    submitting = next;
    submit.disabled = next;
    tabSignin.disabled = next;
    tabSignup.disabled = next;
    if (next) submit.classList.add('settle');
    else submit.classList.remove('settle');
  }

  function clearErrors(): void {
    setText(nameError, '');
    setText(emailError, '');
    setText(passwordError, '');
    setText(status, '');
    nameInput.removeAttribute('aria-invalid');
    emailInput.removeAttribute('aria-invalid');
    passwordInput.removeAttribute('aria-invalid');
  }

  function applyMode(next: AuthMode): void {
    mode = next;
    const signup = mode === 'signup';
    title.textContent = signup ? '注册 StripSearch' : '登录 StripSearch';
    submit.textContent = signup ? '注册并继续' : '登录并继续';
    nameField.hidden = !signup;
    nameInput.required = signup;
    passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    tabSignin.setAttribute('aria-selected', String(!signup));
    tabSignup.setAttribute('aria-selected', String(signup));
    tabSignin.tabIndex = signup ? -1 : 0;
    tabSignup.tabIndex = signup ? 0 : -1;
    disclosure.textContent = signup
      ? '不验证邮箱，也不提供找回密码；账号只用于区分本机记录。'
      : '账号只用于区分本机记录。';
    clearErrors();
  }

  function fail(input: HTMLInputElement, target: HTMLElement, message: string): void {
    input.setAttribute('aria-invalid', 'true');
    setText(target, message);
    input.focus();
  }

  tabSignin.addEventListener('click', () => {
    if (!submitting) applyMode('signin');
  });
  tabSignup.addEventListener('click', () => {
    if (!submitting) applyMode('signup');
  });
  toggle.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    toggle.setAttribute('aria-pressed', String(!showing));
    toggle.textContent = showing ? '显示' : '隐藏';
  });

  for (const element of dialog.querySelectorAll('[data-close-auth]')) {
    element.addEventListener('click', () => dialog.close());
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submitting) return;
    clearErrors();
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (mode === 'signup' && (name.length < 1 || name.length > 60)) {
      fail(nameInput, nameError, '显示名称需为 1–60 个字符。');
      return;
    }
    if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
      fail(emailInput, emailError, '请输入有效的邮箱地址。');
      return;
    }
    if (password.length < 8 || password.length > 128) {
      fail(passwordInput, passwordError, '密码需为 8–128 个字符。');
      return;
    }
    const epoch = openEpoch;
    setSubmitting(true);
    setText(status, mode === 'signup' ? '正在注册…' : '正在登录…');
    const action =
      mode === 'signup' ? api.signUp({ name, email, password }) : api.signIn({ email, password });
    action
      .then(({ user }) => {
        // Ignore a result for a dialog that was closed or reopened meanwhile.
        if (epoch !== openEpoch || !dialog.open) return;
        dialog.close();
        form.reset();
        onSuccess(user);
      })
      .catch((error: unknown) => {
        if (epoch !== openEpoch || !dialog.open) return;
        const message = error instanceof ApiError ? error.message : '认证失败，请稍后再试。';
        setText(status, '');
        setText(emailError, message);
        emailInput.setAttribute('aria-invalid', 'true');
        emailInput.focus();
      })
      .finally(() => {
        if (epoch === openEpoch) setSubmitting(false);
      });
  });

  dialog.addEventListener('close', () => {
    openEpoch += 1;
    setSubmitting(false);
    clearErrors();
    form.reset();
    passwordInput.type = 'password';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.textContent = '显示';
  });

  return {
    open(next, success) {
      if (dialog.open) return;
      onSuccess = success;
      openEpoch += 1;
      applyMode(next);
      dialog.showModal();
      const first = next === 'signup' ? nameInput : emailInput;
      requestAnimationFrame(() => first.focus());
    },
    close() {
      if (dialog.open) dialog.close();
    },
    isOpen() {
      return dialog.open;
    }
  };
}

export function renderUserNav(user: SessionUser | null): void {
  const openAuth = byId<HTMLButtonElement>('open-auth');
  const userMenu = byId<HTMLDivElement>('user-menu');
  const userName = byId<HTMLElement>('user-name');
  openAuth.hidden = Boolean(user);
  userMenu.hidden = !user;
  if (user) {
    userName.textContent = user.name;
    userName.title = user.email;
  }
}

let toastHandle: number | null = null;

export function showToast(text: string, tone: 'info' | 'error' = 'info'): void {
  const toast = byId<HTMLElement>('toast');
  toast.textContent = text;
  toast.dataset.tone = tone;
  toast.hidden = false;
  toast.classList.add('enter');
  if (toastHandle !== null) window.clearTimeout(toastHandle);
  toastHandle = window.setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove('enter');
  }, tone === 'error' ? 6000 : 3200);
}
