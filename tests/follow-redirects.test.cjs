const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'follow-redirects.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName;
        this.children = [];
        this.attributes = {};
        this.listeners = {};
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this._text = '';
        const classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name)
        };
    }
    set textContent(value) {
        this._text = value;
        this.children = [];
    }
    get textContent() {
        return this._text + this.children.map(child => child.textContent).join('');
    }
    append(...children) {
        for (const child of children) {
            this.children.push(...(child.tagName === '#fragment' ? child.children : [child]));
        }
    }
    replaceChildren(...children) {
        this.children = [];
        this._text = '';
        this.append(...children);
    }
    setAttribute(name, value) {
        this.attributes[name] = value;
    }
    removeAttribute(name) {
        delete this.attributes[name];
    }
    addEventListener(name, listener) {
        this.listeners[name] = listener;
    }
    focus() {
        this.focused = true;
    }
}

function setup(fetch = async () => response({ redirectChain: ['https://example.com/'] })) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            elements.set(id, new Element());
        }
        return elements.get(id);
    };
    const timeouts = new Map();
    const intervals = new Map();
    let timerId = 0;
    const copied = [];
    const context = vm.createContext({
        URL, URLSearchParams, AbortController, TypeError, console, fetch,
        navigator: { clipboard: { writeText: async value => copied.push(value) } },
        document: {
            getElementById: element,
            querySelector: element,
            createElement: tag => new Element(tag),
            createDocumentFragment: () => new Element('#fragment'),
            addEventListener: (name, callback) => callback()
        },
        setTimeout: (callback, delay) => {
            timeouts.set(++timerId, { callback, delay });
            return timerId;
        },
        clearTimeout: id => timeouts.delete(id),
        setInterval: callback => {
            intervals.set(++timerId, callback);
            return timerId;
        },
        clearInterval: id => intervals.delete(id)
    });
    vm.runInContext(script, context);
    return { context, element, timeouts, intervals, copied };
}

function response(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers });
}

function submit(app, url) {
    app.element('urlInput').value = url;
    return app.context.handleResolve({ preventDefault() {} });
}

test('accepts HTTP URLs and rejects unsupported schemes or missing schemes', () => {
    const { context } = setup();
    assert.equal(context.parseHttpUrl(' https://example.com/path ').href, 'https://example.com/path');
    assert.equal(context.parseHttpUrl('HTTP://example.com').protocol, 'http:');
    for (const value of ['', 'example.com', 'javascript:alert(1)', 'data:text/html,test', 'ftp://example.com', 'https://', null]) {
        assert.throws(() => context.parseHttpUrl(value));
    }
});

test('removes known tracking parameters without changing functional parameters or encoding', () => {
    const { context } = setup();
    const url = 'https://example.com/path?UTM_Source=test&utm_custom=one&gclid=two&GCLID=three&q=a%20b&ref=home&source=docs&client_id=app&tag=guide#section';
    assert.equal(context.cleanUrl(url), 'https://example.com/path?q=a%20b&ref=home&source=docs&client_id=app&tag=guide#section');
    assert.equal(context.cleanUrl('https://example.com/?%75tm_source=test&id=1&id=2'), 'https://example.com/?id=1&id=2');
    assert.equal(context.cleanUrl('https://example.com/?utm_source=test#section'), 'https://example.com/#section');
    assert.equal(context.cleanUrl('https://example.com/?content=article&keywords=abc&affiliate_id=123'), null);
    assert.equal(context.cleanUrl('https://example.com/#/route?utm_source=needed'), null);
});

test('query removal preserves fragments, including hash-based routes', () => {
    const { context } = setup();
    assert.equal(context.stripAllParams('https://example.com/page?q=test#section'), 'https://example.com/page#section');
    assert.equal(context.stripAllParams('https://example.com/?utm_source=test#/page?id=42'), 'https://example.com/#/page?id=42');
});

test('does not show duplicate URL variants for normalized URLs', () => {
    const { context } = setup();
    assert.equal(context.createUrlBoxes('https://example.com').children.length, 0);
    assert.equal(context.createUrlBoxes('https://example.com/?utm_source=test').children.length, 1);
    assert.equal(context.createUrlBoxes('https://example.com/?utm_source=test&q=needed').children.length, 2);
});

test('creates links and copy buttons without interpreting URL text as HTML', async () => {
    const app = setup();
    const url = 'https://example.com/?q=\'><img src=x onerror=alert(1)>';
    const box = app.context.createUrlBox(url, 'Final destination');
    assert.equal(box.children[1].tagName, 'a');
    assert.equal(box.children[1].textContent, url);
    assert.equal(box.children[1].rel, 'noopener noreferrer');
    const button = box.children[0].children[1];
    await button.listeners.click();
    assert.deepEqual(app.copied, [url]);
    assert.equal(button.textContent, 'Copied!');
    assert.equal(app.element('status').textContent, 'URL copied.');
});

test('reports clipboard failure and restores the copy button', async () => {
    const app = setup();
    app.context.navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
    const button = new Element('button');
    await app.context.copyUrl('https://example.com/', button);
    assert.equal(button.textContent, 'Copy failed');
    assert.match(app.element('status').textContent, /manually/);
    [...app.timeouts.values()][0].callback();
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Copy');
});

test('supports relative, epoch-second, and epoch-millisecond reset values', () => {
    const { context } = setup();
    const now = 1800000000000;
    assert.equal(context.resetSeconds('30', now), 30);
    assert.equal(context.resetSeconds(1800000030, now), 30);
    assert.equal(context.resetSeconds(1800000030000, now), 30);
    assert.equal(context.resetSeconds(1799999990, now), 0);
    for (const value of [null, undefined, '', ' ', 'bad', -1]) {
        assert.equal(context.resetSeconds(value, now), null);
    }
    assert.equal(context.retryAfterSeconds('30', now), 30);
    assert.equal(context.retryAfterSeconds(new Date(now + 30000).toUTCString(), now), 30);
    assert.equal(context.retryAfterSeconds('bad', now), null);
});

test('clears old rate-limit countdowns when the next response omits headers', () => {
    const app = setup();
    app.context.updateRateLimitInfo(response({}, 200, {
        'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '30'
    }));
    assert.equal(app.element('rateLimitInfo').hidden, false);
    assert.equal(app.element('.countdown').textContent, '30');
    assert.equal(app.intervals.size, 1);
    app.context.updateRateLimitInfo(response({}));
    assert.equal(app.element('rateLimitInfo').hidden, true);
    assert.equal(app.intervals.size, 0);
});

test('sends the existing worker request format and renders a final destination', async () => {
    let request;
    const app = setup(async (url, options) => {
        request = { url, options };
        return response({ redirectChain: ['https://short.example/', 'https://example.com/page?utm_source=test#section'] });
    });
    await submit(app, ' https://short.example/ ');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'omit');
    assert.deepEqual(JSON.parse(request.options.body), { url: 'https://short.example/' });
    assert.equal(app.element('status').textContent, 'Resolved 1 redirect.');
    assert.equal(app.element('redirectChain').children.length, 2);
    assert.equal(app.element('result').children[0].children[1].textContent, 'https://example.com/page?utm_source=test#section');
    assert.equal(app.element('chainSection').hidden, false);
    assert.equal(app.element('resolveButton').disabled, false);
    assert.equal(app.timeouts.size, 0);
});

test('reports a URL with no redirects', async () => {
    const app = setup();
    await submit(app, 'https://example.com/');
    assert.match(app.element('status').textContent, /^No HTTP redirects/);
});

test('invalid input clears previous results without making a request', async () => {
    let requests = 0;
    const app = setup(async () => {
        requests++;
        return response({ redirectChain: ['https://example.com/'] });
    });
    await submit(app, 'https://example.com/');
    await submit(app, 'javascript:alert(1)');
    assert.equal(requests, 1);
    assert.equal(app.element('chainSection').hidden, true);
    assert.equal(app.element('redirectChain').children.length, 0);
    assert.equal(app.element('urlInput').attributes['aria-invalid'], 'true');
});

test('rejects invalid worker data and renders server error text safely', async t => {
    const cases = [
        [{}, /invalid redirect chain/],
        [{ redirectChain: [] }, /invalid redirect chain/],
        [{ redirectChain: ['javascript:alert(1)'] }, /invalid URL/],
        [{ redirectChain: [123] }, /invalid URL/],
        [{ error: '<img src=x onerror=alert(1)>' }, /<img/]
    ];
    for (const [data, message] of cases) {
        await t.test(JSON.stringify(data), async () => {
            const app = setup(async () => response(data));
            await submit(app, 'https://example.com/');
            assert.match(app.element('result').textContent, message);
            assert.equal(app.element('result').children[0].children.length, 0);
            assert.equal(app.element('chainSection').hidden, true);
        });
    }
});

test('handles JSON errors, HTML gateway errors, malformed JSON, and network errors', async t => {
    const cases = [
        [async () => response({ error: 'Destination unavailable' }, 502), /Destination unavailable/],
        [async () => new Response('<html>Bad gateway</html>', { status: 502 }), /HTTP 502/],
        [async () => new Response('not JSON'), /invalid redirect chain/],
        [async () => { throw new TypeError('Failed to fetch'); }, /Cannot connect/]
    ];
    for (const [fetch, message] of cases) {
        await t.test(String(message), async () => {
            const app = setup(fetch);
            await submit(app, 'https://example.com/');
            assert.match(app.element('result').textContent, message);
            assert.equal(app.element('resolveButton').disabled, false);
        });
    }
});

test('handles rate limits with JSON, Retry-After, reset headers, or no reset value', async t => {
    const cases = [
        [response({ resetIn: 12 }, 429), /12 seconds/],
        [new Response('limited', { status: 429, headers: { 'Retry-After': '15' } }), /15 seconds/],
        [response({}, 429, { 'X-RateLimit-Reset': '18' }), /18 seconds/],
        [response({}, 429), /Try again later/]
    ];
    for (const [res, message] of cases) {
        await t.test(String(message), async () => {
            const app = setup(async () => res);
            await submit(app, 'https://example.com/');
            assert.match(app.element('result').textContent, message);
            assert.doesNotMatch(app.element('result').textContent, /undefined|NaN/);
        });
    }
});

test('prevents duplicate submissions and permits cancellation', async () => {
    let requests = 0;
    const app = setup((url, options) => {
        requests++;
        return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
    });
    const pending = submit(app, 'https://example.com/');
    assert.equal(app.element('resolveButton').disabled, true);
    assert.equal(app.element('cancelButton').hidden, false);
    await submit(app, 'https://other.example/');
    assert.equal(requests, 1);
    app.element('cancelButton').listeners.click();
    await pending;
    assert.equal(app.element('status').textContent, 'Request cancelled.');
    assert.equal(app.element('cancelButton').hidden, true);
    assert.equal(app.element('urlInput').disabled, false);
    assert.equal(app.timeouts.size, 0);
});

test('aborts a stalled request after 20 seconds and permits another request', async () => {
    const app = setup((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }));
    const pending = submit(app, 'https://example.com/');
    const timeout = [...app.timeouts.values()][0];
    assert.equal(timeout.delay, 20000);
    timeout.callback();
    await pending;
    assert.match(app.element('result').textContent, /20 seconds/);
    assert.equal(app.element('resolveButton').disabled, false);
    app.context.fetch = async () => response({ redirectChain: ['https://example.com/'] });
    await submit(app, 'https://example.com/');
    assert.match(app.element('status').textContent, /^No HTTP redirects/);
});
