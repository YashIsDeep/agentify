// Stands in for a test runner that colours its output; `fail` makes it exit non-zero.
const ESC = "";
process.stdout.write(`${ESC}[32m✔ a task with no due date is never overdue ${ESC}[90m(0.6907ms)${ESC}[39m${ESC}[39m\n`);
process.stdout.write(`${ESC}[34mℹ pass 10${ESC}[39m\n`);
process.stdout.write(`${ESC}[1mreport: ${ESC}[0mhttps://example.test/run/42\n`);
process.stderr.write(`${ESC}[31m✖ 1 failing${ESC}[39m\n`);
process.exit(process.argv[2] === "fail" ? 1 : 0);
