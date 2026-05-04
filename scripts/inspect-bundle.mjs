import { readFileSync, readdirSync } from "node:fs";
const f = readdirSync("dist/assets").find(
  (x) => x.startsWith("web-ifc-") && x.endsWith(".js"),
);
const c = readFileSync("dist/assets/" + f, "utf8");

// Look at every occurrence of d6 with surrounding context
const re = /\bd6\b/g;
let m;
while ((m = re.exec(c)) !== null) {
  const start = Math.max(0, m.index - 25);
  const end = Math.min(c.length, m.index + 35);
  console.log(m.index + ":", JSON.stringify(c.substring(start, end)));
}
