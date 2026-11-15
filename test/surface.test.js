import assert from 'node:assert/strict';
import test from 'node:test';
import { createSurface } from '../src/surface.js';

test('requests every rendered frame without lowering JPEG quality', async () => {
  const commands = [];
  const bytes = Buffer.from('test frame');
  let listener;
  const cdp = {
    isOpen: true,
    onEvent(callback) {
      listener = callback;
      return () => { listener = null; };
    },
    async sendSession(sessionId, method, params) {
      commands.push({ sessionId, method, params });
      if (method === 'Page.startScreencast') {
        queueMicrotask(() => listener?.({
          sessionId,
          method: 'Page.screencastFrame',
          params: {
            sessionId: 1,
            data: bytes.toString('base64'),
            metadata: { deviceWidth: 640, deviceHeight: 480 },
          },
        }));
      }
      return {};
    },
  };
  const surface = createSurface({
    surfacePage: async () => ({ sessionId: 'page', cdp }),
    scale: 1,
    title: 'Test page',
  });

  try {
    const frame = await surface.frame({ after: 0, wait: 0 });
    assert.deepEqual(commands.find(({ method }) => method === 'Page.startScreencast')?.params, {
      format: 'jpeg',
      quality: 72,
      everyNthFrame: 1,
    });
    assert.deepEqual(frame.bytes, bytes);
    assert.equal(frame.width, 640);
    assert.equal(frame.height, 480);
    assert.ok(commands.some(({ method }) => method === 'Page.screencastFrameAck'));
  } finally {
    await surface.close();
  }
  assert.ok(commands.some(({ method }) => method === 'Page.stopScreencast'));
});

const modifiers = Object.freeze({ alt: false, ctrl: false, meta: false, shift: false });
const wheel = (deltaY, extra = {}) => ({ type: 'wheel', x: 300, y: 300, deltaX: 0, deltaY, modifiers, ...extra });
const inputSurface = (scale = 1, { onInput } = {}) => {
  const commands = [];
  const errors = [];
  let sessionId = 'page';
  let menuCloses = 0;
  const menu = { isOpen: false, async close() { menuCloses += 1; menu.isOpen = false; } };
  const cdp = {
    isOpen: true,
    onEvent() { return () => {}; },
    async sendSession(sessionId, method, params) {
      commands.push({ sessionId, method, params });
      if (method.startsWith('Input.') && onInput) return onInput({ sessionId, method, params });
      if (method === 'Runtime.evaluate') return { result: { value: 'copied' } };
      return {};
    },
  };
  const runtime = {
    surfacePage: async () => ({ sessionId, cdp }),
    scale,
    contextMenu: menu,
    controller: 'none',
    async setPanelSize(size) { commands.push({ method: 'resize', params: size }); return size; },
  };
  return {
    surface: createSurface(runtime, { onInputError: (error) => errors.push(error) }),
    commands,
    errors,
    runtime,
    setSession(value) { sessionId = value; },
    menu,
    menuCloses: () => menuCloses,
  };
};

test('combines compatible wheel events within a batch without changing their total distance or inputs', async (context) => {
  const { surface, commands } = inputSurface(2);
  context.after(() => surface.close());
  const events = Object.freeze([
    Object.freeze(wheel(3, { deltaX: 2 })),
    Object.freeze(wheel(5, { deltaX: 4 })),
  ]);
  await surface.input(events);
  await surface.flushInput();
  const mouse = commands.filter(({ method }) => method === 'Input.dispatchMouseEvent');
  assert.equal(mouse.length, 1);
  assert.equal(mouse[0].params.type, 'mouseWheel');
  assert.equal(mouse[0].params.deltaX, 6);
  assert.equal(mouse[0].params.deltaY, 8);
  assert.equal(mouse[0].params.x, 150);
  assert.equal(mouse[0].params.y, 150);
  assert.equal(events[0].deltaY, 3);
  assert.equal(events[1].deltaY, 5);
});

test('keeps wheel events separate when position, modifiers, or direction changes', async (context) => {
  for (const extra of [
    { x: 301 },
    { y: 301 },
    { modifiers: { ...modifiers, ctrl: true } },
    { modifiers: { ...modifiers, shift: true } },
    { deltaY: -3 },
    { deltaX: -2 },
  ]) {
    const { surface, commands } = inputSurface();
    context.after(() => surface.close());
    await surface.input([wheel(3, { deltaX: 2 }), wheel(3, extra)]);
    await surface.flushInput();
    assert.equal(commands.filter(({ method }) => method === 'Input.dispatchMouseEvent').length, 2, JSON.stringify(extra));
  }
});

test('does not combine wheel events across clicks or typing', async (context) => {
  for (const middle of [
    { type: 'pointer', action: 'down', x: 300, y: 300, button: 0, buttons: 1, modifiers },
    { type: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers },
  ]) {
    const { surface, commands } = inputSurface();
    context.after(() => surface.close());
    await surface.input([wheel(3), middle, wheel(5)]);
    await surface.flushInput();
    const inputs = commands.filter(({ method }) => method.startsWith('Input.'));
    assert.equal(inputs.length, 3);
    assert.equal(inputs[0].params.deltaY, 3);
    assert.equal(inputs[2].params.deltaY, 5);
  }
});

test('uses only the first wheel event to dismiss a menu before combining the remaining scroll', async (context) => {
  const fixture = inputSurface();
  context.after(() => fixture.surface.close());
  fixture.menu.isOpen = true;
  await fixture.surface.input([wheel(3), wheel(5), wheel(7)]);
  await fixture.surface.flushInput();
  const mouse = fixture.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent');
  assert.equal(fixture.menuCloses(), 1);
  assert.equal(mouse.length, 1);
  assert.equal(mouse[0].params.deltaY, 12);
});

test('keeps finite wheel values separate when combining would overflow', async (context) => {
  const { surface, commands } = inputSurface();
  context.after(() => surface.close());
  await surface.input([wheel(Number.MAX_VALUE), wheel(Number.MAX_VALUE)]);
  await surface.flushInput();
  const mouse = commands.filter(({ method }) => method === 'Input.dispatchMouseEvent');
  assert.equal(mouse.length, 2);
  assert.ok(mouse.every(({ params }) => Number.isFinite(params.deltaY)));
});

test('does not merge wheel events that have already been dispatched', async (context) => {
  const { surface, commands } = inputSurface();
  context.after(() => surface.close());
  await surface.input([wheel(3)]);
  await surface.flushInput();
  await surface.input([wheel(5)]);
  await surface.flushInput();
  assert.deepEqual(commands.filter(({ method }) => method === 'Input.dispatchMouseEvent').map(({ params }) => params.deltaY), [3, 5]);
});

const turn = () => new Promise((resolve) => setImmediate(resolve));
const hover = { type: 'pointer', action: 'move', x: 300, y: 300, button: -1, buttons: 0, modifiers };
const press = { type: 'pointer', action: 'down', x: 300, y: 300, button: 0, buttons: 1, modifiers };
const key = { type: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers };

test('accepts hover input without waiting for Chrome acknowledgements across packets', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: () => gate.promise });
  context.after(() => { gate.resolve({}); return fixture.surface.close(); });
  let accepted = false;
  const first = fixture.surface.input([hover]).then(() => { accepted = true; });
  await turn();
  assert.equal(accepted, true, 'hover acknowledgement held the host input queue');
  await first;
  await fixture.surface.input([{ ...hover, x: 301 }]);
  assert.deepEqual(fixture.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent').map(({ params }) => params.type), ['mouseMoved', 'mouseMoved']);
  gate.resolve({});
  await fixture.surface.flushInput();
});

test('waits for hover input before clicks, typing, and text insertion', async (context) => {
  for (const boundary of [press, key, { type: 'text', text: 'typed' }]) {
    const gate = Promise.withResolvers();
    const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseMoved' ? gate.promise : {} });
    context.after(() => { gate.resolve({}); return fixture.surface.close(); });
    await fixture.surface.input([hover]);
    let done = false;
    const action = fixture.surface.input([boundary]).then(() => { done = true; });
    await turn();
    assert.equal(done, false);
    assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 1);
    gate.resolve({});
    await action;
    assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 2);
  }
});

test('keeps held-button drag moves blocking', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: () => gate.promise });
  context.after(() => { gate.resolve({}); return fixture.surface.close(); });
  let done = false;
  const action = fixture.surface.input([{ ...hover, buttons: 1 }]).then(() => { done = true; });
  await turn();
  assert.equal(done, false);
  gate.resolve({});
  await action;
});

test('accepts a wheel after pending hover but barriers wait for both acknowledgements', async (context) => {
  const hoverGate = Promise.withResolvers();
  const wheelGate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseMoved' ? hoverGate.promise : wheelGate.promise });
  context.after(() => { hoverGate.resolve({}); wheelGate.resolve({}); return fixture.surface.close(); });
  await fixture.surface.input([hover]);
  let done = false;
  await fixture.surface.input([wheel(3)]);
  const action = fixture.surface.flushInput().then(() => { done = true; });
  await turn();
  assert.equal(done, false);
  assert.deepEqual(fixture.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent').map(({ params }) => params.type), ['mouseMoved', 'mouseWheel']);
  wheelGate.resolve({});
  await turn();
  assert.equal(done, false);
  hoverGate.resolve({});
  await action;
});

test('keeps hover blocking while the shared context menu is open', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: () => gate.promise });
  context.after(() => { gate.resolve({}); return fixture.surface.close(); });
  fixture.menu.isOpen = true;
  let done = false;
  const action = fixture.surface.input([hover]).then(() => { done = true; });
  await turn();
  assert.equal(done, false);
  gate.resolve({});
  await action;
});

test('drains hover input before clipboard, resize, and control handoff complete', async (context) => {
  for (const kind of ['clipboard', 'resize', 'control']) {
    const gate = Promise.withResolvers();
    const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseMoved' ? gate.promise : {} });
    context.after(() => { gate.resolve({}); return fixture.surface.close(); });
    await fixture.surface.input([hover]);
    let done = false;
    const action = (kind === 'clipboard' ? fixture.surface.clipboard() : kind === 'resize' ? fixture.surface.resize({ width: 500, height: 400 }) : fixture.surface.control('agent')).then(() => { done = true; });
    await turn();
    assert.equal(done, false, kind);
    assert.equal(fixture.commands.some(({ method }) => method === 'Runtime.evaluate' || method === 'resize'), false);
    gate.resolve({});
    await action;
    if (kind === 'control') assert.equal(fixture.runtime.controller, 'agent');
  }
});

test('reports asynchronous input failures and rejects the next operation instead of swallowing them', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseMoved' ? gate.promise : {} });
  context.after(() => fixture.surface.close());
  await fixture.surface.input([hover]);
  gate.reject(new Error('Chrome refused input'));
  await turn();
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0].message, /Chrome refused input/);
  await assert.rejects(fixture.surface.input([key]), /Chrome refused input/);
  await fixture.surface.input([key]);
});

test('does not drain input when the manager repeats the same controller for the next packet', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: () => gate.promise });
  context.after(() => { gate.resolve({}); return fixture.surface.close(); });
  await fixture.surface.control('user');
  await fixture.surface.input([hover]);
  let done = false;
  const claim = Promise.resolve(fixture.surface.control('user')).then(() => { done = true; });
  await turn();
  assert.equal(done, true);
  await claim;
  gate.resolve({});
  await fixture.surface.flushInput();
});

test('does not replay old-view input or let its late failure poison a new view', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseMoved' ? gate.promise : {} });
  context.after(() => fixture.surface.close());
  await fixture.surface.input([hover]);
  fixture.setSession('new-page');
  fixture.surface.retarget();
  await fixture.surface.input([{ type: 'text', text: 'new view' }]);
  gate.reject(new Error('Old target closed'));
  await turn();
  assert.equal(fixture.errors.length, 0);
  assert.deepEqual(fixture.commands.filter(({ method }) => method.startsWith('Input.')).map(({ sessionId }) => sessionId), ['page', 'new-page']);
});

test('refuses a discrete input if the view changes while its preceding input drains', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseMoved' ? gate.promise : {} });
  context.after(() => fixture.surface.close());
  await fixture.surface.input([hover]);
  const click = fixture.surface.input([press]);
  const rejected = assert.rejects(click, /browser view changed/i);
  await turn();
  fixture.setSession('new-page');
  fixture.surface.retarget();
  gate.resolve({});
  await rejected;
  assert.equal(fixture.commands.some(({ params }) => params?.type === 'mousePressed'), false);
});

test('closes without waiting for hover acknowledgements and suppresses shutdown errors', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: () => gate.promise });
  context.after(() => fixture.surface.close());
  await fixture.surface.input([hover]);
  await fixture.surface.close();
  gate.reject(new Error('Chrome stopped'));
  await turn();
  assert.equal(fixture.errors.length, 0);
});

test('does not copy or resize a new view after waiting for old-view hover', async (context) => {
  for (const kind of ['clipboard', 'resize']) {
    const gate = Promise.withResolvers();
    const fixture = inputSurface(1, { onInput: () => gate.promise });
    context.after(() => { gate.resolve({}); return fixture.surface.close(); });
    await fixture.surface.input([hover]);
    const action = kind === 'clipboard' ? fixture.surface.clipboard() : fixture.surface.resize({ width: 500, height: 400 });
    const rejected = assert.rejects(action, /browser view changed/i);
    await turn();
    fixture.setSession('new-page');
    fixture.surface.retarget();
    gate.resolve({});
    await rejected;
    assert.equal(fixture.commands.some(({ method }) => method === 'Runtime.evaluate' || method === 'resize'), false);
  }
});

test('merges only compatible pending wheels across packets and replaces adjacent pending hover', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(2, { onInput: () => gate.promise });
  context.after(() => { gate.resolve({}); return fixture.surface.close(); });
  await fixture.surface.input([wheel(1)]);
  await fixture.surface.input([wheel(3)]);
  await fixture.surface.input([wheel(5)]);
  await fixture.surface.input([hover]);
  await fixture.surface.input([{ ...hover, x: 320 }]);
  await fixture.surface.input([wheel(7)]);
  assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 1);
  gate.resolve({});
  await fixture.surface.flushInput();
  const inputs = fixture.commands.filter(({ method }) => method.startsWith('Input.')).map(({ params }) => params);
  assert.deepEqual(inputs.map(({ type, deltaY }) => [type, deltaY]), [['mouseWheel', 1], ['mouseWheel', 8], ['mouseMoved', undefined], ['mouseWheel', 7]]);
  assert.equal(inputs[2].x, 160);
});

test('keeps pending wheel direction, position, modifier, overflow and hover boundaries', async (context) => {
  for (const next of [wheel(-3), wheel(3, { x: 301 }), wheel(3, { y: 301 }), wheel(3, { modifiers: { ...modifiers, shift: true } }), wheel(Number.MAX_VALUE)]) {
    const gate = Promise.withResolvers();
    const fixture = inputSurface(1, { onInput: () => gate.promise });
    context.after(() => { gate.resolve({}); return fixture.surface.close(); });
    await fixture.surface.input([wheel(1)]);
    await fixture.surface.input([wheel(next.deltaY === Number.MAX_VALUE ? Number.MAX_VALUE : 2)]);
    await fixture.surface.input([next]);
    gate.resolve({});
    await fixture.surface.flushInput();
    assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 3);
  }
});

test('does not replace pending hover across modifier changes', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: () => gate.promise });
  context.after(() => { gate.resolve({}); return fixture.surface.close(); });
  await fixture.surface.input([wheel(1)]);
  await fixture.surface.input([hover]);
  await fixture.surface.input([{ ...hover, modifiers: { ...modifiers, shift: true } }]);
  gate.resolve({});
  await fixture.surface.flushInput();
  assert.equal(fixture.commands.filter(({ params }) => params?.type === 'mouseMoved').length, 2);
});

test('Ctrl/Meta wheel stays blocking and unmerged behind preceding scrolling', async (context) => {
  for (const modifier of ['ctrl', 'meta']) {
    const gate = Promise.withResolvers();
    const fixture = inputSurface(1, { onInput: () => gate.promise });
    context.after(() => { gate.resolve({}); return fixture.surface.close(); });
    await fixture.surface.input([wheel(1)]);
    let done = false;
    const special = wheel(3, { modifiers: { ...modifiers, [modifier]: true } });
    const action = fixture.surface.input([special, special]).then(() => { done = true; });
    await turn();
    assert.equal(done, false);
    assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 1);
    gate.resolve({});
    await action;
    assert.deepEqual(fixture.commands.filter(({ method }) => method.startsWith('Input.')).map(({ params }) => params.deltaY), [1, 3, 3]);
  }
});

test('serializes wheel dispatch and drains queued scroll before discrete input', async (context) => {
  for (const boundary of [press, key, { ...hover, buttons: 1 }, { type: 'text', text: 'typed' }]) {
    const gates = [Promise.withResolvers(), Promise.withResolvers()];
    let wheels = 0;
    const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseWheel' ? gates[wheels++].promise : {} });
    context.after(() => { gates.forEach((gate) => gate.resolve({})); return fixture.surface.close(); });
    await fixture.surface.input([wheel(1)]);
    await fixture.surface.input([wheel(2)]);
    const action = fixture.surface.input([boundary]);
    await turn();
    assert.equal(wheels, 1);
    gates[0].resolve({});
    await turn();
    assert.equal(wheels, 2);
    assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 2);
    gates[1].resolve({});
    await action;
    assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 3);
  }
});

test('retarget cancels pending wheels and an old pump cannot drain the new view', async (context) => {
  const oldGate = Promise.withResolvers();
  const newGate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: ({ sessionId }) => sessionId === 'page' ? oldGate.promise : newGate.promise });
  context.after(() => { oldGate.resolve({}); newGate.resolve({}); return fixture.surface.close(); });
  await fixture.surface.input([wheel(1)]);
  await fixture.surface.input([wheel(2)]);
  fixture.setSession('new-page');
  fixture.surface.retarget();
  await fixture.surface.input([wheel(3)]);
  await fixture.surface.input([wheel(4)]);
  oldGate.reject(new Error('old session closed'));
  await turn();
  assert.equal(fixture.errors.length, 0);
  assert.deepEqual(fixture.commands.filter(({ method }) => method.startsWith('Input.')).map(({ sessionId, params }) => [sessionId, params.deltaY]), [['page', 1], ['new-page', 3]]);
  newGate.resolve({});
  await fixture.surface.flushInput();
  assert.deepEqual(fixture.commands.filter(({ method }) => method.startsWith('Input.')).map(({ params }) => params.deltaY), [1, 3, 4]);
});

test('reports wheel pump failures, cancels pending input and rejects its barrier', async (context) => {
  const gate = Promise.withResolvers();
  const fixture = inputSurface(1, { onInput: ({ params }) => params.type === 'mouseWheel' ? gate.promise : {} });
  context.after(() => fixture.surface.close());
  await fixture.surface.input([wheel(1)]);
  await fixture.surface.input([wheel(2)]);
  const rejected = assert.rejects(fixture.surface.input([key]), /wheel refused/);
  gate.reject(new Error('wheel refused'));
  await rejected;
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.commands.filter(({ method }) => method.startsWith('Input.')).length, 1);
  await fixture.surface.input([key]);
});
