const { randomBytes } = require("node:crypto");

const GAME_LIMITS = [
  "This starter creates 2D, single-player Canvas games from a fixed original collection game template.",
  "3D engines, online multiplayer, generated media, publishing, and arbitrary code uploads are not configured."
];

function gameId() {
  return randomBytes(16).toString("hex");
}

function makeTitle(prompt) {
  const firstSentence = prompt.trim()
    .replace(/^(?:i want|please build|build|create|make)\s+(?:me\s+)?(?:a|an|the)?\s*/i, "")
    .split(/[.!?](?:\s|$)/, 1)[0]
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .slice(0, 70)
    .trim();
  return firstSentence || "Untitled arcade game";
}

function createGameSpecification(prompt) {
  const unsupportedRequests = [];
  const unsupportedPatterns = [
    [/\b3d\b|three[- ]?dimensional/i, "3D scenes and models"],
    [/\bmultiplayer\b|\bco-?op\b|\bonline\b/i, "online or local multiplayer"],
    [/\b(leaderboards?|high scores?)\b/i, "shared leaderboards"],
    [/\b(ai|artificial intelligence)\b/i, "provider-backed AI generation"],
    [/\b(music|soundtrack|sound effects?)\b/i, "generated audio"],
    [/\b(publish|release|app store)\b/i, "external publishing"]
  ];
  for (const [pattern, feature] of unsupportedPatterns) {
    if (pattern.test(prompt)) unsupportedRequests.push(feature);
  }

  return {
    name: makeTitle(prompt),
    originalPrompt: prompt,
    summary: "A private 2D arcade game: move your glowing character and collect the drifting energy orbs.",
    engine: "HTML5 Canvas 2D",
    gameplayLoop: "Move around the arena, collect orbs, and grow your score.",
    mechanics: [
      "Top-down movement with keyboard or touch",
      "Collect an orb to earn one point and move it to a new location",
      "Restart the game at any time"
    ],
    camera: "Fixed top-down view",
    controls: { keyboard: "Arrow keys or WASD", touch: "Touch or drag within the arena" },
    difficulty: "normal",
    moveSpeed: 240,
    unsupportedRequests
  };
}

function refineGameSpecification(specification, instruction) {
  const next = structuredClone(specification);
  const request = instruction.trim();
  if (/\b(easier|easy|less difficult|lower difficulty)\b/i.test(request)) {
    next.difficulty = "easy";
    next.moveSpeed = 190;
    return { specification: next, summary: "The game is now easier: movement is slower and easier to control." };
  }
  if (/\b(harder|hard|more difficult|increase difficulty)\b/i.test(request)) {
    next.difficulty = "hard";
    next.moveSpeed = 310;
    return { specification: next, summary: "The game is now harder: movement is faster and requires more precision." };
  }
  if (/\b(normal difficulty|reset difficulty|make it normal)\b/i.test(request)) {
    next.difficulty = "normal";
    next.moveSpeed = 240;
    return { specification: next, summary: "The game is back at its normal difficulty." };
  }
  throw new Error(GAME_LIMITS.join(" "));
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function generatePlayableHtml(specification) {
  const safeSpecification = scriptJson({
    name: specification.name,
    moveSpeed: specification.moveSpeed
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>GODS Game Preview</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:14px;color:#eff6ff;background:#080d1a;font:14px system-ui,sans-serif}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 auto 10px;max-width:800px}
h1{margin:0;overflow:hidden;font-size:15px;text-overflow:ellipsis;white-space:nowrap}#score{color:#67e8f9;font-variant-numeric:tabular-nums}
canvas{display:block;width:min(100%,800px);height:auto;margin:auto;aspect-ratio:16/9;border:1px solid #34516e;border-radius:12px;background:#0b1530;touch-action:none}
.tip{max-width:800px;margin:10px auto 0;color:#aab8d0;font-size:12px}
</style>
</head>
<body>
<header class="bar"><h1 id="game-title"></h1><span>Orbs: <output id="score">0</output></span></header>
<canvas id="arena" width="800" height="450" tabindex="0" aria-label="Game arena"></canvas>
<p class="tip">Move with arrow keys, WASD, or by touching and dragging. The preview runs offline in a restricted frame.</p>
<script>
"use strict";
const specification=${safeSpecification};
const canvas=document.querySelector("#arena");
const context=canvas.getContext("2d");
const scoreLabel=document.querySelector("#score");
document.querySelector("#game-title").textContent=specification.name;
const keys=new Set();
let state;
let target=null;
let lastFrame=performance.now();
let lastSnapshot=0;
function reset(){state={x:400,y:225,score:0,orbX:550,orbY:225};target=null;publish("game-state",state)}
function validState(value){return value&&Number.isFinite(value.x)&&value.x>=18&&value.x<=782&&Number.isFinite(value.y)&&value.y>=18&&value.y<=432&&Number.isInteger(value.score)&&value.score>=0&&value.score<=1000000&&Number.isFinite(value.orbX)&&value.orbX>=12&&value.orbX<=788&&Number.isFinite(value.orbY)&&value.orbY>=12&&value.orbY<=438}
function publish(type,value){window.parent.postMessage({contract:"gods-game-v1",type,state:value},"*")}
window.addEventListener("message",event=>{if(event.source!==window.parent||!event.data||event.data.contract!=="gods-game-v1")return;if(event.data.type==="restart")reset();if(event.data.type==="load-state"&&validState(event.data.state)){state={...event.data.state};target=null}});
window.addEventListener("keydown",event=>{const key=event.key.toLowerCase();if(["arrowup","arrowdown","arrowleft","arrowright","w","a","s","d"].includes(key)){event.preventDefault();keys.add(key)}});
window.addEventListener("keyup",event=>keys.delete(event.key.toLowerCase()));
window.addEventListener("blur",()=>keys.clear());
function position(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height}}
canvas.addEventListener("pointerdown",event=>{canvas.setPointerCapture(event.pointerId);target=position(event)});
canvas.addEventListener("pointermove",event=>{if(event.buttons||event.pointerType==="touch")target=position(event)});
canvas.addEventListener("pointerup",()=>{target=null});
function draw(now){const dt=Math.min((now-lastFrame)/1000,.05);lastFrame=now;let dx=(keys.has("arrowright")||keys.has("d")?1:0)-(keys.has("arrowleft")||keys.has("a")?1:0);let dy=(keys.has("arrowdown")||keys.has("s")?1:0)-(keys.has("arrowup")||keys.has("w")?1:0);if(target){dx=target.x-state.x;dy=target.y-state.y;const length=Math.hypot(dx,dy);if(length<5)target=null;else{dx/=length;dy/=length}}else{const length=Math.hypot(dx,dy)||1;dx/=length;dy/=length}state.x=Math.max(18,Math.min(782,state.x+dx*specification.moveSpeed*dt));state.y=Math.max(18,Math.min(432,state.y+dy*specification.moveSpeed*dt));if(Math.hypot(state.x-state.orbX,state.y-state.orbY)<27){state.score+=1;state.orbX=Math.random()*640+80;state.orbY=Math.random()*290+80;publish("game-state",state)}context.clearRect(0,0,800,450);const background=context.createLinearGradient(0,0,800,450);background.addColorStop(0,"#101a39");background.addColorStop(1,"#080d1a");context.fillStyle=background;context.fillRect(0,0,800,450);context.strokeStyle="rgba(103,232,249,.07)";context.lineWidth=1;for(let x=0;x<800;x+=40){context.beginPath();context.moveTo(x,0);context.lineTo(x,450);context.stroke()}for(let y=0;y<450;y+=40){context.beginPath();context.moveTo(0,y);context.lineTo(800,y);context.stroke()}context.shadowBlur=22;context.shadowColor="#f0abfc";context.fillStyle="#f0abfc";context.beginPath();context.arc(state.orbX,state.orbY,10,0,Math.PI*2);context.fill();context.shadowBlur=20;context.shadowColor="#67e8f9";context.fillStyle="#67e8f9";context.beginPath();context.arc(state.x,state.y,14,0,Math.PI*2);context.fill();context.shadowBlur=0;scoreLabel.value=state.score;if(now-lastSnapshot>500){lastSnapshot=now;publish("game-state",state)}requestAnimationFrame(draw)}
reset();requestAnimationFrame(draw);
</script>
</body>
</html>`;
}

function createGameProject(prompt, ownerId, now = new Date().toISOString()) {
  const specification = createGameSpecification(prompt);
  return {
    id: gameId(),
    ownerId,
    title: specification.name,
    originalPrompt: prompt,
    specification,
    status: "IMPLEMENTED_UNVERIFIED",
    latestVersion: 1,
    versions: [{
      version: 1,
      specification,
      source: generatePlayableHtml(specification),
      status: "IMPLEMENTED_UNVERIFIED",
      createdAt: now,
      changeSummary: "Created a playable local Canvas game from the original prompt using the fixed 2D template."
    }],
    createdAt: now,
    updatedAt: now
  };
}

module.exports = {
  GAME_LIMITS,
  createGameProject,
  createGameSpecification,
  generatePlayableHtml,
  refineGameSpecification
};
