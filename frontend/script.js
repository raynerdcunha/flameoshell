"use strict";

/* =========================================================
   FlameOShell Web Demo
   Browser-side simulation of the native FlameOShell
   ========================================================= */

/* ---------------------------------------------------------
   DOM
   --------------------------------------------------------- */

const terminalOutput = document.getElementById("terminalOutput");
const terminalForm = document.getElementById("terminalForm");
const terminalInput = document.getElementById("terminalInput");
const terminalPrompt = document.getElementById("terminalPrompt");
const copyCommand = document.getElementById("copyCommand");


/* ---------------------------------------------------------
   Shell State
   --------------------------------------------------------- */

let sessionActive = true;

let currentPath = ["home", "flame"];

let commandHistory = [];
let historyIndex = 0;

let nextPid = 1000;

let jobs = [];

let foregroundProcess = null;

let commandRunning = false;

const MAX_JOBS = 64;


/* ---------------------------------------------------------
   Virtual Environment
   --------------------------------------------------------- */

const environment = {
    USER: "flame",
    HOME: "/home/flame",
    HOSTNAME: "flameoshell",
    SHELL: "/bin/flameoshell",
    PATH: "/bin:/usr/bin",
    PWD: "/home/flame"
};


/* ---------------------------------------------------------
   Virtual Filesystem
   --------------------------------------------------------- */

const filesystem = {
    type: "directory",
    children: {
        home: {
            type: "directory",
            children: {
                flame: {
                    type: "directory",
                    children: {
                        "flameoshell.c": {
                            type: "file",
                            content:
`#include <stdio.h>

int main(void) {
    printf("FlameOShell\\n");
    return 0;
}
`
                        },

                        Makefile: {
                            type: "file",
                            content:
`CC=gcc
CFLAGS=-Wall -Wextra

all:
\t$(CC) $(CFLAGS) flameoshell.c -o flameoshell
`
                        },

                        "README.md": {
                            type: "file",
                            content:
`# FlameOShell

A lightweight Unix-like shell written in C.

Built-in commands:
pwd
cd
jobs
bg
fg
exit
`
                        },

                        LICENSE: {
                            type: "file",
                            content:
`Apache License 2.0

See the project repository for the complete license text.
`
                        },

                        projects: {
                            type: "directory",
                            children: {
                                demo: {
                                    type: "directory",
                                    children: {
                                        "main.c": {
                                            type: "file",
                                            content:
`#include <stdio.h>

int main(void) {
    printf("Hello from the demo project!\\n");
    return 0;
}
`
                                        },

                                        "notes.txt": {
                                            type: "file",
                                            content:
`FlameOShell demo project
Virtual filesystem
Two-stage pipelines
Job control simulation
`
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};


/* ---------------------------------------------------------
   Path Helpers
   --------------------------------------------------------- */

function normalizePath(parts) {
    const result = [];

    for (const part of parts) {
        if (!part || part === ".") {
            continue;
        }

        if (part === "..") {
            if (result.length > 0) {
                result.pop();
            }
        } else {
            result.push(part);
        }
    }

    return result;
}


function getNode(parts) {
    let node = filesystem;

    for (const part of parts) {
        if (
            !node ||
            node.type !== "directory" ||
            !node.children ||
            !Object.prototype.hasOwnProperty.call(node.children, part)
        ) {
            return null;
        }

        node = node.children[part];
    }

    return node;
}


function resolveNode(path) {
    const parts = absolutePath(path);
    return getNode(parts);
}


function absolutePath(path) {
    if (!path) {
        return currentPath.slice();
    }

    if (path === "~") {
        return ["home", "flame"];
    }

    let parts;

    if (path.startsWith("/")) {
        parts = path.split("/");
    } else {
        parts = currentPath.concat(path.split("/"));
    }

    return normalizePath(parts);
}


function pathToString(parts) {
    if (parts.length === 0) {
        return "/";
    }

    return "/" + parts.join("/");
}


function displayPath() {
    const path = pathToString(currentPath);

    if (path === environment.HOME) {
        return "~";
    }

    if (path.startsWith(environment.HOME + "/")) {
        return "~" + path.slice(environment.HOME.length);
    }

    return path;
}


function updatePrompt() {
    if (!terminalPrompt) {
        return;
    }

    /*
     * The trailing space is intentional.
     * CSS white-space: pre preserves it visually.
     */
    terminalPrompt.textContent =
        `${environment.USER}@${environment.HOSTNAME}:${displayPath()}$ `;
}


/* ---------------------------------------------------------
   Output Helpers
   --------------------------------------------------------- */

function appendText(text = "") {
    const line = document.createElement("div");

    line.textContent = text;

    terminalOutput.appendChild(line);

    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}


function print(text = "") {
    appendText(text);
}


function printCommand(command) {
    const line = document.createElement("div");

    const prompt = document.createElement("span");
    prompt.className = "prompt";
    prompt.textContent =
        `${environment.USER}@${environment.HOSTNAME}:${displayPath()}$ `;

    const commandText = document.createElement("span");
    commandText.className = "command";
    commandText.textContent = command;

    line.appendChild(prompt);
    line.appendChild(commandText);

    terminalOutput.appendChild(line);

    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}


function clearTerminal() {
    terminalOutput.innerHTML = "";
}


/* ---------------------------------------------------------
   Tokenizer
   --------------------------------------------------------- */

/*
 * Matches the important parsing behavior of the native shell:
 *
 * - whitespace separates arguments
 * - double quotes protect spaces
 * - single quotes are NOT special
 * - backslash escaping is NOT implemented
 * - quotes are stripped from quoted arguments
 * - operators are recognized only when standalone
 */

/*
 * Native shell only supports double-quoted spaces.
 * Preserve whether an operator appeared inside quotes.
 */
function tokenizeWithQuoteAwareness(line) {
    const tokens = [];

    let current = "";
    let inDoubleQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            current += char;
            inDoubleQuotes = !inDoubleQuotes;
            continue;
        }

        if (
            (char === " " || char === "\t" || char === "\n") &&
            !inDoubleQuotes
        ) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }

            continue;
        }

        current += char;
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens.map(token => {
        if (
            token.length >= 2 &&
            token.startsWith('"') &&
            token.endsWith('"')
        ) {
            return token.slice(1, -1);
        }

        return token;
    });
}


/* ---------------------------------------------------------
   Pipeline Helpers
   --------------------------------------------------------- */

function findUnquotedPipe(line) {
    let inDoubleQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            inDoubleQuotes = !inDoubleQuotes;
            continue;
        }

        if (char === "|" && !inDoubleQuotes) {
            return i;
        }
    }

    return -1;
}


function splitPipeline(line) {
    const pipeIndex = findUnquotedPipe(line);

    if (pipeIndex === -1) {
        return null;
    }

    return [
        line.slice(0, pipeIndex).trim(),
        line.slice(pipeIndex + 1).trim()
    ];
}


/* ---------------------------------------------------------
   Virtual Process Model
   --------------------------------------------------------- */

function createProcess(command) {
    const pid = nextPid++;

    return {
        pid,
        pgid: pid,
        command,

        status: "R",

        stopped: false,

        timer: null,
        remainingMs: null,
        startedAt: null,

        resolve: null,

        completionPromise: null,
        completionResult: null,

        background: false,
        jobAdded: false,
        doneMessageShown: false,

        resume: null
    };
}


/* ---------------------------------------------------------
   Job Helpers
   --------------------------------------------------------- */

function addJob(process) {
    if (jobs.includes(process)) {
        return true;
    }

    if (jobs.length >= MAX_JOBS) {
        return false;
    }

    jobs.push(process);

    process.jobAdded = true;

    return true;
}


function removeJob(process) {
    const index = jobs.indexOf(process);

    if (index !== -1) {
        jobs.splice(index, 1);
    }

    process.jobAdded = false;
}


function getJob(args) {
    if (!args[0]) {
        return null;
    }

    const index = Number.parseInt(args[0], 10);

    if (
        !Number.isInteger(index) ||
        index < 1 ||
        index > jobs.length
    ) {
        return null;
    }

    return jobs[index - 1];
}


/* ---------------------------------------------------------
   Process Completion
   --------------------------------------------------------- */

function completeProcess(process, result) {
    if (!process || process.status === "D") {
        return;
    }

    process.status = "D";
    process.stopped = false;

    if (process.timer) {
        clearTimeout(process.timer);
        process.timer = null;
    }

    process.remainingMs = 0;

    process.completionResult = result;

    if (process.resolve) {
        const resolve = process.resolve;

        process.resolve = null;

        resolve(result);
    }

    if (
        process.background &&
        jobs.includes(process) &&
        foregroundProcess !== process &&
        !process.doneMessageShown
    ) {
        process.doneMessageShown = true;

        print(
            `[${process.pid}] Done    ${process.command}`
        );

        removeJob(process);
    }
}


function finishProcessPromise(process, result) {
    if (process.status === "D") {
        return;
    }

    completeProcess(process, result);
}


/* ---------------------------------------------------------
   Process Timer
   --------------------------------------------------------- */

function startTimedProcess(process) {
    if (
        process.remainingMs === null ||
        process.remainingMs <= 0
    ) {
        finishProcessPromise(process, {
            code: 0,
            output: ""
        });

        return;
    }

    process.stopped = false;
    process.status = "R";
    process.startedAt = performance.now();

    process.timer = setTimeout(() => {
        process.timer = null;

        if (process.stopped) {
            return;
        }

        process.remainingMs = 0;

        finishProcessPromise(process, {
            code: 0,
            output: ""
        });
    }, process.remainingMs);
}


/* ---------------------------------------------------------
   External Commands
   --------------------------------------------------------- */

const externalCommands = {};


/* ls */

externalCommands.ls = function(args, stdin, process) {
    const target = args[0] || ".";

    const node = resolveNode(target);

    if (!node) {
        return Promise.resolve({
            code: 1,
            output: "ls: No such file or directory"
        });
    }

    if (node.type === "file") {
        return Promise.resolve({
            code: 0,
            output: target
        });
    }

    const names = Object.keys(node.children || {});

    /*
     * Native ls execs the real binary, which prints one entry per
     * line whenever stdout isn't a terminal (e.g. piped into grep
     * or wc). Joining with "\n" here matches that -- joining with
     * a single space instead made every piped command below see
     * the whole listing as one giant "line", so something like
     * "ls | grep .c" would match (or fail to match) the entire
     * directory at once instead of filtering per file.
     */
    return Promise.resolve({
        code: 0,
        output: names.join("\n")
    });
};


/* cat */

externalCommands.cat = function(args, stdin, process) {
    if (args.length === 0) {
        return Promise.resolve({
            code: 0,
            output: stdin || ""
        });
    }

    const outputs = [];

    for (const arg of args) {
        const node = resolveNode(arg);

        if (!node) {
            return Promise.resolve({
                code: 1,
                output: `cat: ${arg}: No such file or directory`
            });
        }

        if (node.type !== "file") {
            return Promise.resolve({
                code: 1,
                output: `cat: ${arg}: Is a directory`
            });
        }

        outputs.push(node.content);
    }

    return Promise.resolve({
        code: 0,
        output: outputs.join("\n")
    });
};


/* echo */

externalCommands.echo = function(args, stdin, process) {
    return Promise.resolve({
        code: 0,
        output: args.join(" ")
    });
};


/* pwd */

externalCommands.pwd = function(args, stdin, process) {
    return Promise.resolve({
        code: 0,
        output: pathToString(currentPath)
    });
};


/* whoami */

externalCommands.whoami = function(args, stdin, process) {
    return Promise.resolve({
        code: 0,
        output: environment.USER
    });
};


/* grep */

externalCommands.grep = function(args, stdin, process) {
    if (args.length < 1) {
        return Promise.resolve({
            code: 2,
            output: "grep: missing pattern"
        });
    }

    const pattern = args[0];

    const text = stdin || "";

    const lines = text.split("\n");

    /*
     * Native grep execs the real binary, which treats the pattern
     * as a regular expression (so "." means "any character", not
     * a literal dot). A plain substring .includes() check made
     * "grep .c" match any line containing the two literal
     * characters "." and "c" together, instead of "any char then
     * c". Falling back to a literal substring match only if the
     * pattern isn't valid regex syntax.
     */
    let matcher;

    try {
        const regex = new RegExp(pattern);
        matcher = line => regex.test(line);
    } catch (e) {
        matcher = line => line.includes(pattern);
    }

    const matches = lines.filter(matcher);

    return Promise.resolve({
        code: matches.length > 0 ? 0 : 1,
        output: matches.join("\n")
    });
};


/* wc */

externalCommands.wc = function(args, stdin, process) {
    const text = stdin || "";

    const lineCount =
        text.length === 0
            ? 0
            : text.split("\n").length;

    const wordCount =
        text.trim().length === 0
            ? 0
            : text.trim().split(/\s+/).length;

    const byteCount =
        new TextEncoder().encode(text).length;

    let output;

    if (args.includes("-l")) {
        output = String(lineCount);
    } else if (args.includes("-w")) {
        output = String(wordCount);
    } else if (args.includes("-c")) {
        output = String(byteCount);
    } else {
        output =
            `${lineCount} ${wordCount} ${byteCount}`;
    }

    return Promise.resolve({
        code: 0,
        output
    });
};


/* head */

externalCommands.head = function(args, stdin, process) {
    const text = stdin || "";

    const lines = text.split("\n");

    let count = 10;

    if (args[0] === "-n" && args[1]) {
        count = Number.parseInt(args[1], 10);
    }

    if (args[0] && args[0].startsWith("-")) {
        const parsed = Number.parseInt(
            args[0].slice(1),
            10
        );

        if (Number.isInteger(parsed)) {
            count = parsed;
        }
    }

    return Promise.resolve({
        code: 0,
        output: lines.slice(0, count).join("\n")
    });
};


/* tail */

externalCommands.tail = function(args, stdin, process) {
    const text = stdin || "";

    const lines = text.split("\n");

    let count = 10;

    if (args[0] === "-n" && args[1]) {
        count = Number.parseInt(args[1], 10);
    }

    if (args[0] && args[0].startsWith("-")) {
        const parsed = Number.parseInt(
            args[0].slice(1),
            10
        );

        if (Number.isInteger(parsed)) {
            count = parsed;
        }
    }

    return Promise.resolve({
        code: 0,
        output: lines.slice(-count).join("\n")
    });
};


/* sleep */

externalCommands.sleep = function(args, stdin, process) {
    if (args.length !== 1) {
        return Promise.resolve({
            code: 1,
            output: "sleep: invalid time interval"
        });
    }

    const seconds = Number(args[0]);

    if (
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        return Promise.resolve({
            code: 1,
            output: "sleep: invalid time interval"
        });
    }

    process.remainingMs = seconds * 1000;

    /*
     * A zero-second sleep should complete immediately.
     */
    if (process.remainingMs === 0) {
        process.status = "D";

        return Promise.resolve({
            code: 0,
            output: ""
        });
    }

    const promise = new Promise(resolve => {
        process.resolve = resolve;
    });

    process.completionPromise = promise;

    startTimedProcess(process);

    return promise;
};


/* true */

externalCommands.true = function(args, stdin, process) {
    return Promise.resolve({
        code: 0,
        output: ""
    });
};


/* false */

externalCommands.false = function(args, stdin, process) {
    return Promise.resolve({
        code: 1,
        output: ""
    });
};


/* ---------------------------------------------------------
   Web-only Commands
   --------------------------------------------------------- */

async function builtinHelp() {
    return {
        code: 0,
        output:
`Built-in commands:
  pwd                 Print working directory
  cd <dir>            Change directory
  jobs                List active jobs
  bg <n>              Resume a stopped job in background
  fg <n>              Bring a job to foreground
  exit                Exit FlameOShell

External commands:
  ls                  List files
  cat <file>          Print file contents
  echo <text>         Print text
  grep <text>         Search input
  wc [-l|-w|-c]       Count lines, words, or bytes
  head [-n N]         Show the first lines
  tail [-n N]         Show the last lines
  sleep <seconds>     Wait for a specified time
  whoami              Print current user
  true                Return success
  false               Return failure

Web demo commands:
  help                Show this help message
  about               About the web demo
  history             Show command history
  clear               Clear the terminal

Notes:
  • Only double quotes are supported
  • Two-stage pipelines are supported
  • < and > redirection are supported
  • >> append redirection is not supported
  • Background pipelines are not supported
  • Pipeline + redirection is not supported
  • No globbing or variable expansion
  • Maximum of 64 tracked jobs`
    };
}


async function builtinAbout() {
    return {
        code: 0,
        output:
`🔥 FlameOShell Web Demo

A browser-side simulation of the native FlameOShell.

This demo provides:
  • Virtual filesystem
  • Virtual processes
  • Job control simulation
  • Pipes
  • Input/output redirection
  • Keyboard signal simulation

No commands are executed on your computer.`
    };
}


async function builtinHistory() {
    return {
        code: 0,
        output: commandHistory
            .map((command, index) =>
                `${index + 1}  ${command}`
            )
            .join("\n")
    };
}


/* ---------------------------------------------------------
   Built-ins
   --------------------------------------------------------- */

async function builtinPwd() {
    return {
        code: 0,
        output: pathToString(currentPath)
    };
}


async function builtinCd(args) {
    if (args.length === 0) {
        return {
            code: 1,
            output: 'flameoshell: Expected argument to "cd"'
        };
    }

    const target = args[0];

    const targetParts = absolutePath(target);

    const node = getNode(targetParts);

    if (!node || node.type !== "directory") {
        return {
            code: 1,
            output: "flameoshell: No such file or directory"
        };
    }

    currentPath = targetParts;

    environment.PWD = pathToString(currentPath);

    updatePrompt();

    return {
        code: 0,
        output: ""
    };
}


async function builtinJobs() {
    const lines = [];

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];

        if (job.status === "D") {
            continue;
        }

        const status =
            job.status === "T"
                ? "Stopped"
                : "Running";

        lines.push(
            `[${i + 1}] ${status.padEnd(8)} ${job.command}`
        );
    }

    return {
        code: 0,
        output: lines.join("\n")
    };
}


async function builtinBg(args) {
    const job = getJob(args);

    if (!job) {
        return {
            code: 1,
            output: "bg: job index not found"
        };
    }

    if (job.status === "R") {
        return {
            code: 1,
            output: "bg: job already running"
        };
    }

    if (job.status === "D") {
        removeJob(job);

        return {
            code: 1,
            output: "bg: job index not found"
        };
    }

    job.background = true;

    job.status = "R";
    job.stopped = false;

    if (typeof job.resume === "function") {
        job.resume();
    }

    return {
        code: 0,
        output: ""
    };
}


async function builtinFg(args) {
    const job = getJob(args);

    if (!job) {
        return {
            code: 1,
            output: "fg: job index not found"
        };
    }

    if (job.status === "D") {
        removeJob(job);

        return {
            code: 1,
            output: "fg: job index not found"
        };
    }

    removeJob(job);

    job.background = false;

    job.status = "R";
    job.stopped = false;

    foregroundProcess = job;

    print(
        `Process ${job.pid} is sent to foreground`
    );

    /*
     * Resume only if the process was stopped.
     */
    if (typeof job.resume === "function") {
        job.resume();
    }

    /*
     * If the process was already complete while being
     * transferred to foreground, finish immediately.
     */
    if (job.status === "D") {
        foregroundProcess = null;

        return job.completionResult || {
            code: 0,
            output: ""
        };
    }

    /*
     * Wait for the original process promise.
     */
    if (job.completionPromise) {
        const result = await job.completionPromise;

        if (foregroundProcess === job) {
            foregroundProcess = null;
        }

        return result;
    }

    foregroundProcess = null;

    return {
        code: 0,
        output: ""
    };
}


async function builtinExit() {
    sessionActive = false;

    /*
     * Simulate the native shell terminating tracked jobs.
     */
    for (const job of [...jobs]) {
        if (job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
        }

        job.stopped = false;
        job.status = "D";

        if (job.resolve) {
            const resolve = job.resolve;

            job.resolve = null;

            resolve({
                code: 143,
                output: ""
            });
        }
    }

    jobs = [];

    foregroundProcess = null;

    terminalInput.disabled = true;
    terminalInput.readOnly = true;

    return {
        code: 0,
        output: "FlameOShell session ended. Refresh the page to start a new session."
    };
}


/* ---------------------------------------------------------
   Command Resolution
   --------------------------------------------------------- */

function isBuiltin(name) {
    return [
        "pwd",
        "cd",
        "jobs",
        "bg",
        "fg",
        "exit"
    ].includes(name);
}


function isWebCommand(name) {
    return [
        "help",
        "about",
        "history",
        "clear"
    ].includes(name);
}


function isExternalCommand(name) {
    return Object.prototype.hasOwnProperty.call(
        externalCommands,
        name
    );
}


/* ---------------------------------------------------------
   Redirection
   --------------------------------------------------------- */

function parseRedirection(tokens) {
    const commandTokens = [];

    let inputFile = null;
    let outputFile = null;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === ">>") {
            return {
                error: "flameoshell: >> redirection is not supported"
            };
        }

        if (token === "<") {
            if (!tokens[i + 1]) {
                return {
                    error: "flameoshell: missing input file"
                };
            }

            inputFile = tokens[i + 1];

            i++;

            continue;
        }

        if (token === ">") {
            if (!tokens[i + 1]) {
                return {
                    error: "flameoshell: missing output file"
                };
            }

            outputFile = tokens[i + 1];

            i++;

            continue;
        }

        commandTokens.push(token);
    }

    return {
        commandTokens,
        inputFile,
        outputFile
    };
}


function readFile(path) {
    const node = resolveNode(path);

    if (!node) {
        return {
            ok: false,
            error: "No such file or directory"
        };
    }

    if (node.type !== "file") {
        return {
            ok: false,
            error: "Is a directory"
        };
    }

    return {
        ok: true,
        content: node.content
    };
}


function writeFile(path, content) {
    const parts = absolutePath(path);

    if (parts.length === 0) {
        return {
            ok: false,
            error: "cannot write to root directory"
        };
    }

    const filename = parts.pop();

    const parent = getNode(parts);

    if (!parent || parent.type !== "directory") {
        return {
            ok: false,
            error: "No such file or directory"
        };
    }

    const existing = parent.children[filename];

    if (existing && existing.type === "directory") {
        return {
            ok: false,
            error: "Is a directory"
        };
    }

    parent.children[filename] = {
        type: "file",
        content
    };

    return {
        ok: true
    };
}


/* ---------------------------------------------------------
   Execute External Command
   --------------------------------------------------------- */

async function runExternal(
    name,
    args,
    stdin,
    process
) {
    if (!isExternalCommand(name)) {
        return {
            code: 127,
            output: "flameoshell: Command not found"
        };
    }

    return externalCommands[name](
        args,
        stdin,
        process
    );
}


/* ---------------------------------------------------------
   Execute One Command
   --------------------------------------------------------- */

async function executeSingle(
    commandLine,
    inputOverride = "",
    suppressOutput = false
) {
    let tokens = tokenizeWithQuoteAwareness(commandLine);

    if (tokens.length === 0) {
        return {
            code: 0,
            output: ""
        };
    }

    const redirection = parseRedirection(tokens);

    if (redirection.error) {
        return {
            code: 1,
            output: redirection.error
        };
    }

    tokens = redirection.commandTokens;

    if (tokens.length === 0) {
        return {
            code: 0,
            output: ""
        };
    }

    const name = tokens[0];
    const args = tokens.slice(1);

    /*
     * Built-ins do not create virtual processes.
     */
    if (isBuiltin(name)) {
        let result;

        if (name === "pwd") {
            result = await builtinPwd();
        } else if (name === "cd") {
            result = await builtinCd(args);
        } else if (name === "jobs") {
            result = await builtinJobs();
        } else if (name === "bg") {
            result = await builtinBg(args);
        } else if (name === "fg") {
            result = await builtinFg(args);
        } else if (name === "exit") {
            result = await builtinExit();
        }

        if (
            redirection.outputFile &&
            result.output !== undefined
        ) {
            const writeResult = writeFile(
                redirection.outputFile,
                result.output
            );

            if (!writeResult.ok) {
                result.code = 1;
                result.output =
                    `flameoshell: ${writeResult.error}`;
            } else {
                result.output = "";
            }
        }

        return result;
    }

    /*
     * Web-only commands.
     */
    if (isWebCommand(name)) {
        let result;

        if (name === "help") {
            result = await builtinHelp();
        } else if (name === "about") {
            result = await builtinAbout();
        } else if (name === "history") {
            result = await builtinHistory();
        } else if (name === "clear") {
            clearTerminal();

            result = {
                code: 0,
                output: ""
            };
        }

        return result;
    }

    /*
     * External command.
     */
    const process = createProcess(commandLine);

    foregroundProcess = process;

    let stdin = inputOverride || "";

    /*
     * Input redirection.
     */
    if (redirection.inputFile) {
        const file = readFile(
            redirection.inputFile
        );

        if (!file.ok) {
            foregroundProcess = null;

            return {
                code: 1,
                output:
                    `flameoshell: ${redirection.inputFile}: ${file.error}`
            };
        }

        stdin = file.content;
    }

    let result;

    try {
        result = await runExternal(
            name,
            args,
            stdin,
            process
        );
    } catch (error) {
        result = {
            code: 1,
            output: String(error)
        };
    }

    /*
     * If Ctrl+C interrupted the process, runExternal may
     * already have resolved with code 130.
     */
    if (process.status !== "D") {
        process.status = "D";
    }

    if (foregroundProcess === process) {
        foregroundProcess = null;
    }

    /*
     * Output redirection.
     */
    if (redirection.outputFile) {
        const writeResult = writeFile(
            redirection.outputFile,
            result.output || ""
        );

        if (!writeResult.ok) {
            result = {
                code: 1,
                output:
                    `flameoshell: ${redirection.outputFile}: ${writeResult.error}`
            };
        } else {
            result.output = "";
        }
    }

    return result;
}


/* ---------------------------------------------------------
   Execute Pipeline
   --------------------------------------------------------- */

async function executePipeline(
    leftCommand,
    rightCommand
) {
    const leftTokens =
        tokenizeWithQuoteAwareness(leftCommand);

    const rightTokens =
        tokenizeWithQuoteAwareness(rightCommand);

    if (
        leftTokens.length === 0 ||
        rightTokens.length === 0
    ) {
        return {
            code: 1,
            output: "flameoshell: invalid pipeline"
        };
    }

    /*
     * Native implementation has exactly two stages.
     */
    if (findUnquotedPipe(rightCommand) !== -1) {
        /*
         * The native shell does not create a third pipeline
         * stage. The second | effectively becomes an argument.
         * Keep the behavior simple here.
         */
    }

    /*
     * Pipe + redirection is not supported.
     */
    if (
        leftTokens.includes("<") ||
        leftTokens.includes(">") ||
        leftTokens.includes(">>") ||
        rightTokens.includes("<") ||
        rightTokens.includes(">") ||
        rightTokens.includes(">>")
    ) {
        return {
            code: 1,
            output:
                "flameoshell: redirection with pipelines is not supported"
        };
    }

    /*
     * Background pipelines are not supported.
     */
    if (
        leftTokens[leftTokens.length - 1] === "&" ||
        rightTokens[rightTokens.length - 1] === "&"
    ) {
        return {
            code: 1,
            output:
                "flameoshell: background pipelines are not supported"
        };
    }

    const leftName = leftTokens[0];
    const leftArgs = leftTokens.slice(1);

    const rightName = rightTokens[0];
    const rightArgs = rightTokens.slice(1);

    /*
     * Pipeline processes are represented by one virtual
     * process group.
     */
    const process = createProcess(
        `${leftCommand} | ${rightCommand}`
    );

    foregroundProcess = process;

    let firstResult;

    try {
        if (isBuiltin(leftName)) {
            if (leftName === "pwd") {
                firstResult = await builtinPwd();
            } else if (leftName === "cd") {
                firstResult = await builtinCd(leftArgs);
            } else if (leftName === "jobs") {
                firstResult = await builtinJobs();
            } else {
                firstResult = {
                    code: 1,
                    output:
                        `flameoshell: ${leftName}: unsupported in pipeline`
                };
            }
        } else if (isWebCommand(leftName)) {
            if (leftName === "help") {
                firstResult = await builtinHelp();
            } else if (leftName === "about") {
                firstResult = await builtinAbout();
            } else if (leftName === "history") {
                firstResult = await builtinHistory();
            } else {
                firstResult = {
                    code: 0,
                    output: ""
                };
            }
        } else {
            firstResult = await runExternal(
                leftName,
                leftArgs,
                "",
                process
            );
        }
    } catch (error) {
        firstResult = {
            code: 1,
            output: String(error)
        };
    }

    /*
     * Ctrl+C / Ctrl+Z can happen while the first process
     * is active.
     */
    if (
        firstResult.code === 130 ||
        process.status === "D"
    ) {
        if (foregroundProcess === process) {
            foregroundProcess = null;
        }

        return firstResult;
    }

    let secondResult;

    try {
        if (isBuiltin(rightName)) {
            if (rightName === "pwd") {
                secondResult = await builtinPwd();
            } else if (rightName === "jobs") {
                secondResult = await builtinJobs();
            } else {
                secondResult = {
                    code: 1,
                    output:
                        `flameoshell: ${rightName}: unsupported in pipeline`
                };
            }
        } else if (isWebCommand(rightName)) {
            if (rightName === "help") {
                secondResult = await builtinHelp();
            } else if (rightName === "about") {
                secondResult = await builtinAbout();
            } else if (rightName === "history") {
                secondResult = await builtinHistory();
            } else {
                secondResult = {
                    code: 0,
                    output: ""
                };
            }
        } else {
            secondResult = await runExternal(
                rightName,
                rightArgs,
                firstResult.output || "",
                process
            );
        }
    } catch (error) {
        secondResult = {
            code: 1,
            output: String(error)
        };
    }

    process.status = "D";

    if (foregroundProcess === process) {
        foregroundProcess = null;
    }

    return secondResult;
}


/* ---------------------------------------------------------
   Background Command Handling
   --------------------------------------------------------- */

function detectBackground(tokens) {
    if (tokens.length === 0) {
        return false;
    }

    return tokens[tokens.length - 1] === "&";
}


async function executeBackground(commandLine) {
    let tokens = tokenizeWithQuoteAwareness(commandLine);

    if (
        tokens.length === 0 ||
        tokens[tokens.length - 1] !== "&"
    ) {
        return {
            code: 1,
            output: "flameoshell: invalid background command"
        };
    }

    tokens = tokens.slice(0, -1);

    if (tokens.length === 0) {
        return {
            code: 1,
            output: "flameoshell: invalid background command"
        };
    }

    /*
     * Background built-ins are not valid native job-control
     * processes. Treat them as a normal command instead.
     */
    const commandWithoutAmpersand =
        tokens.map(token => `"${token}"`).join(" ");

    const pipeIndex =
        findUnquotedPipe(commandWithoutAmpersand);

    if (pipeIndex !== -1) {
        return {
            code: 1,
            output:
                "flameoshell: background pipelines are not supported"
        };
    }

    const redirectionTokens =
        tokenizeWithQuoteAwareness(
            commandWithoutAmpersand
        );

    const redirection =
        parseRedirection(redirectionTokens);

    if (redirection.error) {
        return {
            code: 1,
            output: redirection.error
        };
    }

    const commandTokens =
        redirection.commandTokens;

    if (commandTokens.length === 0) {
        return {
            code: 1,
            output: "flameoshell: invalid background command"
        };
    }

    const name = commandTokens[0];

    if (
        redirection.inputFile ||
        redirection.outputFile
    ) {
        /*
         * Native FlameOShell supports redirection with
         * background external commands.
         */
    }

    const args = commandTokens.slice(1);

    const process = createProcess(
        tokens.join(" ")
    );

    process.background = true;

    /*
     * Native FlameOShell still forks and runs the process even
     * once its fixed-size job table is full -- it just has no
     * slot left to track it in, so fg/bg/jobs can't see it. Match
     * that here: fall through and run the process either way,
     * only skipping the jobs-table bookkeeping when it's full
     * instead of refusing to run the command at all. completeProcess()
     * already only prints the "[n] Done" line and cleans up the jobs
     * array when the process is actually in it, so an untracked
     * process finishes silently, exactly like native.
     */
    addJob(process);

    let stdin = "";

    if (redirection.inputFile) {
        const file = readFile(
            redirection.inputFile
        );

        if (!file.ok) {
            removeJob(process);

            return {
                code: 1,
                output:
                    `flameoshell: ${redirection.inputFile}: ${file.error}`
            };
        }

        stdin = file.content;
    }

    const promise = runExternal(
        name,
        args,
        stdin,
        process
    );

    process.completionPromise = promise;

    /*
     * For sleep, runExternal has already started the timer.
     * For immediate commands, resolve in the same async flow.
     */
    promise.then(result => {
        if (process.status === "T") {
            return;
        }

        if (process.status !== "D") {
            completeProcess(process, result);
        }
    });

    print(
        `PID ${process.pid} is sent to background`
    );

    return {
        code: 0,
        output: ""
    };
}


/* ---------------------------------------------------------
   Execute Command Line
   --------------------------------------------------------- */

async function executeCommandLine(line) {
    const trimmed = line.trim();

    if (!trimmed) {
        return {
            code: 0,
            output: ""
        };
    }

    const tokens = tokenizeWithQuoteAwareness(trimmed);

    /*
     * Native shell matches a builtin against the first token
     * of the whole raw line before it ever looks for '&' or
     * '|'. A builtin takes a fixed set of arguments and simply
     * never reads anything past them, so trailing "&" or "| cmd"
     * text is silently ignored rather than treated as an
     * operator. Matching that order here (instead of checking
     * for background/pipeline first) is what makes "jobs | cat"
     * just run jobs() and "cd /tmp &" just cd normally, exactly
     * like the native shell -- rather than this demo being
     * accidentally more capable than the real one.
     */
    if (isBuiltin(tokens[0]) || isWebCommand(tokens[0])) {
        return executeSingle(trimmed);
    }

    /*
     * Background command.
     */
    if (detectBackground(tokens)) {
        return executeBackground(trimmed);
    }

    /*
     * Pipeline.
     */
    const pipeline = splitPipeline(trimmed);

    if (pipeline) {
        return executePipeline(
            pipeline[0],
            pipeline[1]
        );
    }

    /*
     * Single command.
     */
    return executeSingle(trimmed);
}


/* ---------------------------------------------------------
   Ctrl+C
   --------------------------------------------------------- */

function interruptForegroundProcess() {
    if (!foregroundProcess) {
        print("^C");
        return false;
    }

    const process = foregroundProcess;

    /*
     * Stop timer if one exists.
     */
    if (process.timer) {
        clearTimeout(process.timer);
        process.timer = null;
    }

    process.stopped = false;
    process.status = "D";
    process.remainingMs = 0;

    foregroundProcess = null;

    print("^C");

    if (process.resolve) {
        const resolve = process.resolve;

        process.resolve = null;

        resolve({
            code: 130,
            output: ""
        });
    }

    /*
     * If it was somehow tracked, remove it.
     */
    removeJob(process);

    return true;
}


/* ---------------------------------------------------------
   Ctrl+Z
   --------------------------------------------------------- */

function stopForegroundProcess() {
    if (!foregroundProcess) {
        return false;
    }

    const process = foregroundProcess;

    /*
     * Calculate how much time remains before stopping.
     */
    if (
        process.timer &&
        process.startedAt !== null &&
        process.remainingMs !== null
    ) {
        const elapsed =
            performance.now() - process.startedAt;

        process.remainingMs = Math.max(
            0,
            process.remainingMs - elapsed
        );

        clearTimeout(process.timer);

        process.timer = null;
    }

    process.stopped = true;
    process.status = "T";

    foregroundProcess = null;

    /*
     * A stopped foreground process becomes a tracked job.
     */
    process.background = false;

    addJob(process);

    /*
     * The process promise stays unresolved.
     * fg/bg will resume it later.
     */
    process.resume = () => {
        if (process.status !== "T") {
            return;
        }

        process.stopped = false;
        process.status = "R";

        /*
         * If this process has a timer, resume the remaining
         * time rather than restarting the original duration.
         */
        if (
            process.remainingMs !== null &&
            process.remainingMs > 0
        ) {
            startTimedProcess(process);
        } else {
            completeProcess(process, {
                code: 0,
                output: ""
            });
        }
    };

    print(
        `[${jobs.indexOf(process) + 1}] Stopped    ${process.command}`
    );

    return true;
}


/* ---------------------------------------------------------
   Keyboard Handling
   --------------------------------------------------------- */

document.addEventListener("keydown", event => {
    /*
     * Ctrl+C
     */
    if (
        event.ctrlKey &&
        event.key.toLowerCase() === "c"
    ) {
        event.preventDefault();

        if (foregroundProcess) {
            interruptForegroundProcess();
            commandRunning = false;

            if (sessionActive) {
                terminalInput.disabled = false;
                terminalInput.readOnly = false;
                terminalInput.focus();
            }
        } else {
            print("^C");
        }

        return;
    }

    /*
     * Ctrl+Z
     */
    if (
        event.ctrlKey &&
        event.key.toLowerCase() === "z"
    ) {
        event.preventDefault();

        if (foregroundProcess) {
            stopForegroundProcess();
            commandRunning = false;

            if (sessionActive) {
                terminalInput.disabled = false;
                terminalInput.readOnly = false;
                terminalInput.focus();
            }
        }

        return;
    }

    /*
     * Ctrl+L
     */
    if (
        event.ctrlKey &&
        event.key.toLowerCase() === "l"
    ) {
        event.preventDefault();

        if (!commandRunning && sessionActive) {
            clearTerminal();
            updatePrompt();
        }

        return;
    }

    /*
     * Do not allow ordinary editing while a foreground
     * process owns the terminal.
     */
    if (
        commandRunning &&
        !event.ctrlKey &&
        !event.altKey
    ) {
        event.preventDefault();
    }
});


/* ---------------------------------------------------------
   History + Completion
   --------------------------------------------------------- */

terminalInput.addEventListener("keydown", event => {
    if (commandRunning) {
        return;
    }

    /*
     * Up
     */
    if (event.key === "ArrowUp") {
        event.preventDefault();

        if (commandHistory.length === 0) {
            return;
        }

        historyIndex = Math.max(
            0,
            historyIndex - 1
        );

        terminalInput.value =
            commandHistory[historyIndex] || "";

        return;
    }

    /*
     * Down
     */
    if (event.key === "ArrowDown") {
        event.preventDefault();

        if (commandHistory.length === 0) {
            return;
        }

        historyIndex = Math.min(
            commandHistory.length,
            historyIndex + 1
        );

        terminalInput.value =
            commandHistory[historyIndex] || "";

        return;
    }

    /*
     * Tab completion
     */
    if (event.key === "Tab") {
        event.preventDefault();

        const value = terminalInput.value;

        if (
            value.includes(" ") ||
            value.includes("\t")
        ) {
            return;
        }

        const commands = [
            ...Object.keys(externalCommands),
            "pwd",
            "cd",
            "jobs",
            "bg",
            "fg",
            "exit",
            "help",
            "about",
            "history",
            "clear"
        ];

        const matches = commands.filter(command =>
            command.startsWith(value)
        );

        if (matches.length === 1) {
            terminalInput.value =
                matches[0] + " ";
        }

        return;
    }
});


/* ---------------------------------------------------------
   Terminal Form
   --------------------------------------------------------- */

terminalForm.addEventListener("submit", async event => {
    event.preventDefault();

    if (!sessionActive) {
        return;
    }

    if (commandRunning) {
        return;
    }

    const command = terminalInput.value;

    terminalInput.value = "";

    if (!command.trim()) {
        updatePrompt();
        terminalInput.focus();
        return;
    }

    commandHistory.push(command);

    historyIndex = commandHistory.length;

    printCommand(command);

    /*
     * Determine whether this is a background command.
     * This mirrors the same precedence executeCommandLine()
     * uses internally: a builtin/web command is matched
     * against the first token before '&' is ever considered,
     * so "cd /tmp &" or "exit &" run (and print) normally
     * instead of being routed down the background branch
     * below, which never prints a result at all (it assumes
     * a real background job already announced itself via
     * "PID n is sent to background").
     */
    const tokens =
        tokenizeWithQuoteAwareness(command.trim());

    const isBackground =
        !(isBuiltin(tokens[0]) || isWebCommand(tokens[0])) &&
        detectBackground(tokens);

    /*
     * Background commands do not lock the terminal.
     */
    if (isBackground) {
        await executeCommandLine(command);

        updatePrompt();

        terminalInput.disabled = false;
        terminalInput.readOnly = false;

        terminalInput.focus();

        return;
    }

    /*
     * Foreground command locks normal input.
     * Ctrl+C / Ctrl+Z remain globally available.
     */
    commandRunning = true;

    terminalInput.disabled = true;
    terminalInput.readOnly = true;

    const result =
        await executeCommandLine(command);

    /*
     * Print the result, if there is one. Note this does NOT
     * gate on sessionActive: "exit" itself sets sessionActive
     * to false as the first thing it does, so gating on it
     * here meant exit's own "session ended" confirmation never
     * printed -- the only command whose result that check could
     * ever suppress was exit's.
     */
    if (
        result &&
        result.output
    ) {
        print(result.output);
    }

    /*
     * If fg brought a process to foreground and it
     * completed normally, foregroundProcess is null.
     */
    if (!foregroundProcess) {
        commandRunning = false;
    }

    if (sessionActive && !foregroundProcess) {
        terminalInput.disabled = false;
        terminalInput.readOnly = false;

        updatePrompt();

        terminalInput.focus();
    }
});


/* ---------------------------------------------------------
   Command Buttons
   --------------------------------------------------------- */

document
    .querySelectorAll("[data-command]")
    .forEach(button => {
        button.addEventListener("click", () => {
            if (!sessionActive || commandRunning) {
                return;
            }

            const command =
                button.getAttribute("data-command");

            if (!command) {
                return;
            }

            terminalInput.value = command;

            terminalInput.focus();
        });
    });


/* ---------------------------------------------------------
   Copy Git Command
   --------------------------------------------------------- */

if (copyCommand) {
    copyCommand.addEventListener("click", async () => {
        const command =
            "git clone https://github.com/raynerdcunha/flameoshell.git";

        try {
            await navigator.clipboard.writeText(command);

            const originalText =
                copyCommand.textContent;

            copyCommand.textContent = "Copied!";

            setTimeout(() => {
                copyCommand.textContent =
                    originalText;
            }, 1200);
        } catch (error) {
            /*
             * Clipboard may be unavailable depending on
             * browser security context.
             */
            print(
                "git clone https://github.com/raynerdcunha/flameoshell.git"
            );
        }
    });
}


/* ---------------------------------------------------------
   Startup
   --------------------------------------------------------- */

clearTerminal();

appendText("🔥 FlameOShell Web Demo");
appendText(
    "Browser-side simulation of the native FlameOShell."
);
appendText(
    "Virtual filesystem • virtual processes • safe sandbox"
);
appendText("");
appendText("Type help to see available commands.");
appendText("");

updatePrompt();

terminalInput.disabled = false;
terminalInput.readOnly = false;

terminalInput.focus();