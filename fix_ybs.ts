import * as fs from 'fs';

const filePath = '/app/applet/src/data/ybsData.ts';
const content = fs.readFileSync(filePath, 'utf8');

const targetStr = 'export const YBS_VEHICLES: any[] = [];';
const targetIndex = content.indexOf(targetStr);

if (targetIndex !== -1) {
  const perfectEndIndex = targetIndex + targetStr.length;
  // Truncate the file right after the first occurrence of export const YBS_VEHICLES: any[] = [];
  const cleanContent = content.slice(0, perfectEndIndex).trim() + '\n';
  fs.writeFileSync(filePath, cleanContent, 'utf8');
  console.log("Success! Truncated file cleanly.");
} else {
  console.log(`Error: Target string not found!`);
}

// Read back the verified last 300 chars
const verifiedContent = fs.readFileSync(filePath, 'utf8');
console.log("Verified last 300 characters:");
console.log(JSON.stringify(verifiedContent.slice(-300)));

// Let's count the brace and bracket balance
let braceCount = 0;
let bracketCount = 0;
let inString: string | null = null;
let isEscape = false;

for (let i = 0; i < verifiedContent.length; i++) {
  const char = verifiedContent[i];
  if (isEscape) {
    isEscape = false;
    continue;
  }
  if (char === '\\') {
    isEscape = true;
    continue;
  }
  if (inString) {
    if (char === inString) {
      inString = null;
    }
    continue;
  }
  if (char === '"' || char === "'" || char === "`") {
    inString = char;
    continue;
  }

  if (char === '{') braceCount++;
  else if (char === '}') braceCount--;
  else if (char === '[') bracketCount++;
  else if (char === ']') bracketCount--;
}

console.log(`Unclosed counts:`);
console.log(`Braces {}: ${braceCount}`);
console.log(`Brackets []: ${bracketCount}`);
console.log(`Is in string?: ${inString}`);
