const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const path = require("node:path");
const { AuthStore } = require("../src/store");
const { verifyPassword } = require("../src/auth");

async function provisionAdmin({ dataDir, email, password, targetEmail = "gxqstudio@gmail.com" }) {
  if (typeof email !== "string" || email.trim().toLowerCase() !== targetEmail.trim().toLowerCase()) {
    throw new Error(`Only the configured super-admin account (${targetEmail}) can be provisioned.`);
  }
  const store = new AuthStore(dataDir);
  await store.initialize();
  const user = await store.findUserByEmail(targetEmail);
  if (!user || !await verifyPassword(password, user.salt, user.passwordHash)) {
    throw new Error("The configured account does not exist or its password could not be verified.");
  }
  if (!await store.promoteAdmin(user)) {
    throw new Error("The account changed during verification; no role was updated.");
  }
  return { id: user.id, email: user.email, role: "admin" };
}

async function readHiddenPassword(prompt) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let password = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Provisioning cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(password);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
        } else {
          password += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run this command from an interactive terminal; passwords must not be passed in command arguments.");
  }

  const targetEmail = process.env.GODS_SUPER_ADMIN_EMAIL || "gxqstudio@gmail.com";
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let email;
  try {
    email = await prompt.question(`Account email to provision as administrator [${targetEmail}]: `);
  } finally {
    prompt.close();
  }
  const password = await readHiddenPassword("Verify the account password (input hidden): ");
  const admin = await provisionAdmin({
    dataDir: process.env.GODS_DATA_DIR || path.join(__dirname, "..", "data"),
    email: email || targetEmail,
    password,
    targetEmail
  });
  console.log(`Administrator provisioned: ${admin.email}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { provisionAdmin };
