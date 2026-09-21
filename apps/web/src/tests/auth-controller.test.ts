import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { ApiError } from '../client/api.js';

const env = installDom();
const { createAuthController } = await import('../client/auth.js');

interface PendingAuth {
  calls: { type: string; payload: Record<string, string> }[];
  pending: {
    resolve: (value: { user: { id: string; email: string; name: string } }) => void;
    reject: (error: unknown) => void;
  }[];
  api: { signIn: (payload: Record<string, string>) => Promise<unknown>; signUp: (payload: Record<string, string>) => Promise<unknown> };
}

function makeFakeApi(): PendingAuth {
  const calls: PendingAuth['calls'] = [];
  const pending: PendingAuth['pending'] = [];
  const api: PendingAuth['api'] = {
    signIn(payload) {
      calls.push({ type: 'signin', payload });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    signUp(payload) {
      calls.push({ type: 'signup', payload });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
  };
  return { calls, pending, api };
}

function authElements(): {
  form: HTMLFormElement;
  email: HTMLInputElement;
  password: HTMLInputElement;
  submit: HTMLButtonElement;
  tabSignup: HTMLButtonElement;
  tabSignin: HTMLButtonElement;
} {
  return {
    form: env.document.getElementById('auth-form') as HTMLFormElement,
    email: env.document.getElementById('auth-email') as HTMLInputElement,
    password: env.document.getElementById('auth-password') as HTMLInputElement,
    submit: env.document.getElementById('auth-submit') as HTMLButtonElement,
    tabSignup: env.document.getElementById('tab-signup') as HTMLButtonElement,
    tabSignin: env.document.getElementById('tab-signin') as HTMLButtonElement
  };
}

async function tick(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function submit(form: HTMLFormElement): void {
  const EventCtor = (env.window as unknown as { Event: new (type: string, init?: EventInit) => Event }).Event;
  form.dispatchEvent(new EventCtor('submit', { cancelable: true, bubbles: true }));
}

test('duplicate auth submissions and tab changes are blocked while pending', async () => {
  const { calls, pending, api } = makeFakeApi();
  const controller = createAuthController(api as never);
  const els = authElements();
  let success = 0;
  controller.open('signin', () => {
    success += 1;
  });
  els.email.value = 'a@example.test';
  els.password.value = 'password-1234';
  submit(els.form);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(els.submit.disabled, true);
  assert.equal(els.tabSignup.disabled, true);

  submit(els.form);
  await tick();
  assert.equal(calls.length, 1, 'a second submit while pending must be ignored');

  const ClickCtor = (env.window as unknown as { Event: new (type: string) => Event }).Event;
  els.tabSignup.dispatchEvent(new ClickCtor('click'));
  assert.equal(els.tabSignup.getAttribute('aria-selected'), 'false');

  pending[0]?.resolve({ user: { id: 'u1', email: 'a@example.test', name: 'A' } });
  await tick();
  assert.equal(success, 1);
  assert.equal(els.submit.disabled, false);
  assert.equal(controller.isOpen(), false);
});

test('a late response from a closed dialog cannot invoke a newer callback', async () => {
  const { calls, pending, api } = makeFakeApi();
  const controller = createAuthController(api as never);
  const els = authElements();
  let first = 0;
  let second = 0;

  controller.open('signin', () => {
    first += 1;
  });
  els.email.value = 'first@example.test';
  els.password.value = 'password-1234';
  submit(els.form);
  await tick();
  assert.equal(calls.length, 1);

  controller.close();
  await tick();

  controller.open('signin', () => {
    second += 1;
  });
  els.email.value = 'second@example.test';
  els.password.value = 'password-1234';
  submit(els.form);
  await tick();
  assert.equal(calls.length, 2);

  // Resolving the abandoned request must not fire either callback.
  pending[0]?.resolve({ user: { id: 'u1', email: 'first@example.test', name: 'First' } });
  await tick();
  assert.equal(first, 0);
  assert.equal(second, 0);
  assert.equal(controller.isOpen(), true);

  // The current request resolves normally.
  pending[1]?.resolve({ user: { id: 'u2', email: 'second@example.test', name: 'Second' } });
  await tick();
  assert.equal(first, 0);
  assert.equal(second, 1);
  assert.equal(controller.isOpen(), false);
});

test('a failed auth response shows an error and re-enables the form', async () => {
  const { calls, pending, api } = makeFakeApi();
  const controller = createAuthController(api as never);
  const els = authElements();
  controller.open('signin', () => undefined);
  els.email.value = 'bad@example.test';
  els.password.value = 'password-1234';
  submit(els.form);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(els.submit.disabled, true);
  // A rejected request surfaces an error and re-enables the form.
  pending[0]?.reject(new ApiError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password'));
  await tick();
  assert.equal(els.submit.disabled, false);
  assert.equal(els.email.getAttribute('aria-invalid'), 'true');
  assert.equal(env.document.getElementById('auth-email-error')?.textContent, '邮箱或密码不正确，请重试。');
});

test('client-side validation blocks an invalid email before any request', async () => {
  const { calls, api } = makeFakeApi();
  const controller = createAuthController(api as never);
  const els = authElements();
  controller.open('signin', () => undefined);
  els.email.value = 'not-an-email';
  els.password.value = 'password-1234';
  submit(els.form);
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(els.email.getAttribute('aria-invalid'), 'true');
});
