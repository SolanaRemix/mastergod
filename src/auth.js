const { promisify } = require("node:util");
const {
  createHash,
  randomBytes,
  randomUUID,
  scrypt: scryptCallback,
  timingSafeEqual
} = require("node:crypto");

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !email.includes("..");
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
  return {
    salt: salt.toString("hex"),
    passwordHash: derivedKey.toString("hex")
  };
}

async function verifyPassword(password, saltHex, expectedHex) {
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (salt.length !== 16 || expected.length !== PASSWORD_BYTES) return false;
  const actual = await scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

class AuthService {
  constructor(store) {
    this.store = store;
  }

  async register(emailInput, password) {
    if (typeof emailInput !== "string" || typeof password !== "string") {
      throw new Error("Enter a valid email address and password.");
    }

    const email = normalizeEmail(emailInput);
    if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
    if (password.length < 12 || Buffer.byteLength(password, "utf8") > 256) {
      throw new Error("Choose a password between 12 and 256 bytes.");
    }

    const credentials = await hashPassword(password);
    const user = await this.store.createUser({
      id: randomUUID(),
      email,
      role: "user",
      ...credentials,
      createdAt: new Date().toISOString()
    });
    if (!user) throw new Error("An account with that email already exists.");
    return publicUser(user);
  }

  async login(emailInput, password) {
    if (typeof emailInput !== "string" || typeof password !== "string" || password.length > 256) {
      return null;
    }

    const user = await this.store.findUserByEmail(normalizeEmail(emailInput));
    if (!user) {
      const salt = Buffer.alloc(16);
      await scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
      return null;
    }
    if (!await verifyPassword(password, user.salt, user.passwordHash)) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const session = {
      tokenHash: hashSessionToken(token),
      userId: user.id,
      expiresAt,
      createdAt: new Date().toISOString()
    };
    const created = await this.store.createSessionIfPasswordMatches(user, session);
    return created ? { user: publicUser(user), session: { token, expiresAt } } : null;
  }

  async createSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.store.createSession({
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt,
      createdAt: new Date().toISOString()
    });
    return { token, expiresAt };
  }

  async requestPasswordReset(emailInput) {
    if (typeof emailInput !== "string" || emailInput.length > 254) return null;
    const user = await this.store.findUserByEmail(normalizeEmail(emailInput));
    if (!user) return null;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await this.store.createPasswordReset({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      expiresAt,
      createdAt: new Date().toISOString()
    });
    return token;
  }

  async resetPassword(token, password) {
    if (
      typeof token !== "string"
      || token.length !== 43
      || typeof password !== "string"
      || password.length < 12
      || Buffer.byteLength(password, "utf8") > 256
    ) return false;

    const credentials = await hashPassword(password);
    return this.store.consumePasswordReset(hashSessionToken(token), credentials);
  }

  async getSession(token) {
    if (!token || token.length > 128) return null;
    const session = await this.store.findSession(hashSessionToken(token));
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    const user = await this.store.findUserById(session.userId);
    return user ? { user: publicUser(user), expiresAt: session.expiresAt } : null;
  }

  async deleteSession(token) {
    if (token && token.length <= 128) {
      await this.store.deleteSession(hashSessionToken(token));
    }
  }
}

module.exports = {
  AuthService,
  hashPassword,
  hashSessionToken,
  publicUser,
  verifyPassword
};
