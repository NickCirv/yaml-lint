#!/usr/bin/env node
// yaml-lint — pure JS YAML validator, formatter, and linter
// Zero external dependencies — built-in modules only

import { readFileSync, writeFileSync, readdirSync, statSync, watchFile } from 'fs';
import { resolve, extname, join, relative } from 'path';
import { cwd } from 'process';

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  red:    s => USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s,
  green:  s => USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s,
  cyan:   s => USE_COLOR ? `\x1b[36m${s}\x1b[0m` : s,
  bold:   s => USE_COLOR ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    s => USE_COLOR ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ─── Pure JS YAML Parser ─────────────────────────────────────────────────────
class YamlParseError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'YamlParseError';
    this.line = line;
    this.col = col;
  }
}

function parseYaml(input) {
  const documents = [];
  const errors = [];

  // Split into documents by ---
  const docStrings = splitDocuments(input);

  for (const { content, offset } of docStrings) {
    try {
      const result = parseDocument(content, offset, errors);
      documents.push(result);
    } catch (e) {
      errors.push({ line: e.line || 1, col: e.col || 1, message: e.message });
      documents.push(null);
    }
  }

  return { documents, errors };
}

function splitDocuments(input) {
  const lines = input.split('\n');
  const docs = [];
  let start = 0;
  let lineOffset = 1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---' && i > 0) {
      docs.push({ content: lines.slice(start, i).join('\n'), offset: lineOffset });
      lineOffset += (i - start);
      start = i;
    }
  }
  docs.push({ content: lines.slice(start).join('\n'), offset: lineOffset });
  return docs.length ? docs : [{ content: input, offset: 1 }];
}

function parseDocument(input, lineOffset, errors) {
  const state = {
    input,
    pos: 0,
    line: lineOffset,
    col: 1,
    lineOffset,
    errors,
    anchors: {},
  };
  skipBOM(state);
  skipDocumentStart(state);
  const value = parseValue(state, 0);
  skipWhitespaceAndComments(state);
  return value;
}

function skipBOM(state) {
  if (state.input.charCodeAt(state.pos) === 0xFEFF) advance(state);
}

function skipDocumentStart(state) {
  const rest = state.input.slice(state.pos);
  if (/^---/.test(rest)) { advanceBy(state, 3); skipToNextLine(state); }
  if (/^%YAML/.test(rest)) skipToNextLine(state);
}

function advance(state) {
  if (state.input[state.pos] === '\n') {
    state.line++;
    state.col = 1;
  } else {
    state.col++;
  }
  state.pos++;
}

function advanceBy(state, n) {
  for (let i = 0; i < n; i++) advance(state);
}

function peek(state, offset = 0) {
  return state.input[state.pos + offset];
}

function remaining(state) {
  return state.input.slice(state.pos);
}

function skipToNextLine(state) {
  while (state.pos < state.input.length && state.input[state.pos] !== '\n') advance(state);
  if (state.pos < state.input.length) advance(state);
}

function skipWhitespaceAndComments(state) {
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (ch === ' ' || ch === '\t' || ch === '\r') { advance(state); continue; }
    if (ch === '\n') { advance(state); continue; }
    if (ch === '#') { skipToNextLine(state); continue; }
    break;
  }
}

function skipInlineWhitespace(state) {
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (ch === ' ' || ch === '\t') { advance(state); continue; }
    break;
  }
}

function currentIndent(state) {
  let pos = state.pos;
  while (pos > 0 && state.input[pos - 1] !== '\n') pos--;
  let indent = 0;
  while (state.input[pos + indent] === ' ') indent++;
  return indent;
}

function getLineIndent(input, lineStart) {
  let i = lineStart;
  while (i < input.length && input[i] === ' ') i++;
  return i - lineStart;
}

function parseValue(state, indent) {
  skipWhitespaceAndComments(state);
  if (state.pos >= state.input.length) return null;

  const ch = peek(state);

  // Anchor
  if (ch === '&') {
    advance(state);
    const nameStart = state.pos;
    while (state.pos < state.input.length && !/[\s,\[\]{}]/.test(state.input[state.pos])) advance(state);
    const anchorName = state.input.slice(nameStart, state.pos);
    skipInlineWhitespace(state);
    const val = parseValue(state, indent);
    state.anchors[anchorName] = val;
    return val;
  }

  // Alias
  if (ch === '*') {
    advance(state);
    const nameStart = state.pos;
    while (state.pos < state.input.length && !/[\s,\[\]{}]/.test(state.input[state.pos])) advance(state);
    const aliasName = state.input.slice(nameStart, state.pos);
    if (!(aliasName in state.anchors)) {
      state.errors.push({ line: state.line, col: state.col, message: `Undefined alias: *${aliasName}` });
      return null;
    }
    return state.anchors[aliasName];
  }

  // Flow sequence
  if (ch === '[') return parseFlowSequence(state, indent);
  // Flow mapping
  if (ch === '{') return parseFlowMapping(state, indent);
  // Block sequence
  if (ch === '-' && (peek(state, 1) === ' ' || peek(state, 1) === '\n' || peek(state, 1) === undefined)) {
    return parseBlockSequence(state, indent);
  }
  // Quoted strings
  if (ch === '"') return parseDoubleQuoted(state);
  if (ch === "'") return parseSingleQuoted(state);
  // Block scalars
  if (ch === '|' || ch === '>') return parseBlockScalar(state, indent);
  // Mapping or scalar
  return parseMappingOrScalar(state, indent);
}

function parseFlowSequence(state, _indent) {
  advance(state); // [
  const items = [];
  skipWhitespaceAndComments(state);
  while (state.pos < state.input.length && peek(state) !== ']') {
    items.push(parseFlowValue(state));
    skipWhitespaceAndComments(state);
    if (peek(state) === ',') { advance(state); skipWhitespaceAndComments(state); }
  }
  if (peek(state) === ']') advance(state);
  else state.errors.push({ line: state.line, col: state.col, message: 'Expected ]' });
  return items;
}

function parseFlowMapping(state, _indent) {
  advance(state); // {
  const obj = {};
  const keys = [];
  skipWhitespaceAndComments(state);
  while (state.pos < state.input.length && peek(state) !== '}') {
    const key = parseFlowKey(state);
    skipWhitespaceAndComments(state);
    if (peek(state) === ':') { advance(state); skipInlineWhitespace(state); }
    const val = parseFlowValue(state);
    if (keys.includes(key)) {
      state.errors.push({ line: state.line, col: state.col, message: `Duplicate key: ${key}`, isDuplicateKey: true });
    }
    keys.push(key);
    obj[key] = val;
    skipWhitespaceAndComments(state);
    if (peek(state) === ',') { advance(state); skipWhitespaceAndComments(state); }
  }
  if (peek(state) === '}') advance(state);
  else state.errors.push({ line: state.line, col: state.col, message: 'Expected }' });
  return obj;
}

function parseFlowKey(state) {
  if (peek(state) === '"') return parseDoubleQuoted(state);
  if (peek(state) === "'") return parseSingleQuoted(state);
  const start = state.pos;
  while (state.pos < state.input.length && !/[:\s,\[\]{}]/.test(state.input[state.pos])) advance(state);
  return state.input.slice(start, state.pos).trim();
}

function parseFlowValue(state) {
  skipWhitespaceAndComments(state);
  const ch = peek(state);
  if (ch === '[') return parseFlowSequence(state, 0);
  if (ch === '{') return parseFlowMapping(state, 0);
  if (ch === '"') return parseDoubleQuoted(state);
  if (ch === "'") return parseSingleQuoted(state);
  // Plain scalar in flow context
  const start = state.pos;
  while (state.pos < state.input.length && !/[,\[\]{}]/.test(state.input[state.pos]) && state.input[state.pos] !== '\n') {
    advance(state);
  }
  return coerce(state.input.slice(start, state.pos).trim());
}

function parseDoubleQuoted(state) {
  advance(state); // "
  let str = '';
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (ch === '"') { advance(state); break; }
    if (ch === '\\') {
      advance(state);
      const esc = state.input[state.pos];
      const escMap = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
      if (esc in escMap) { str += escMap[esc]; advance(state); }
      else if (esc === 'u') {
        advance(state);
        const hex = state.input.slice(state.pos, state.pos + 4);
        str += String.fromCharCode(parseInt(hex, 16));
        advanceBy(state, 4);
      } else { str += esc; advance(state); }
    } else { str += ch; advance(state); }
  }
  return str;
}

function parseSingleQuoted(state) {
  advance(state); // '
  let str = '';
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (ch === "'") {
      advance(state);
      if (state.input[state.pos] === "'") { str += "'"; advance(state); }
      else break;
    } else { str += ch; advance(state); }
  }
  return str;
}

function parseBlockScalar(state, baseIndent) {
  const style = peek(state); // | or >
  advance(state);
  let chomping = 'clip'; // clip, strip, keep
  let indentIndicator = null;
  while (state.pos < state.input.length && state.input[state.pos] !== '\n') {
    const ch = state.input[state.pos];
    if (ch === '-') { chomping = 'strip'; advance(state); }
    else if (ch === '+') { chomping = 'keep'; advance(state); }
    else if (ch >= '1' && ch <= '9') { indentIndicator = parseInt(ch); advance(state); }
    else if (ch === '#') { skipToNextLine(state); break; }
    else advance(state);
  }
  if (state.input[state.pos] === '\n') advance(state);

  // Determine indent
  let detectedIndent = indentIndicator;
  const lines = [];
  const startPos = state.pos;

  // Peek ahead to determine indent
  if (!detectedIndent) {
    let pp = state.pos;
    while (pp < state.input.length && state.input[pp] === '\n') pp++;
    let ind = 0;
    const lineStart = pp;
    while (pp < state.input.length && state.input[pp] === ' ') { ind++; pp++; }
    detectedIndent = ind;
  }

  const blockLines = [];
  while (state.pos < state.input.length) {
    const lineStart = state.pos;
    let indent = 0;
    while (state.pos < state.input.length && state.input[state.pos] === ' ') { indent++; state.pos++; state.col++; }
    if (state.pos < state.input.length && state.input[state.pos] === '\n') {
      blockLines.push('');
      advance(state);
      continue;
    }
    if (indent < detectedIndent) {
      state.pos = lineStart;
      state.col = 1;
      break;
    }
    const lineContent = [];
    while (state.pos < state.input.length && state.input[state.pos] !== '\n') {
      lineContent.push(state.input[state.pos]);
      state.pos++;
      state.col++;
    }
    blockLines.push(' '.repeat(indent - detectedIndent) + lineContent.join(''));
    if (state.pos < state.input.length) advance(state);
  }

  // Apply chomping
  let result = '';
  if (style === '|') {
    result = blockLines.join('\n');
  } else { // >
    result = foldLines(blockLines);
  }
  if (chomping === 'strip') result = result.trimEnd();
  else if (chomping === 'clip') result = result.replace(/\n+$/, '') + '\n';
  else result = result + '\n'; // keep
  return result;
}

function foldLines(lines) {
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') {
      result += '\n';
    } else if (i > 0 && lines[i - 1] !== '' && result && result[result.length - 1] !== '\n') {
      result += ' ' + lines[i];
    } else {
      result += lines[i];
    }
  }
  return result;
}

function parseMappingOrScalar(state, indent) {
  // Try to detect if this is a mapping
  const savedPos = state.pos;
  const savedLine = state.line;
  const savedCol = state.col;

  // Read a potential key
  const keyStart = state.pos;
  let inQuote = false;
  let quoteChar = null;

  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; quoteChar = null; advance(state); }
      else advance(state);
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; advance(state); continue; }
    if (ch === ':' && (state.input[state.pos + 1] === ' ' || state.input[state.pos + 1] === '\n' || state.input[state.pos + 1] === undefined || state.pos + 1 >= state.input.length)) {
      // This is a mapping
      state.pos = savedPos; state.line = savedLine; state.col = savedCol;
      return parseBlockMapping(state, indent);
    }
    if (ch === '\n') break;
    advance(state);
  }

  // It's a scalar
  state.pos = savedPos; state.line = savedLine; state.col = savedCol;
  return parseScalar(state, indent);
}

function parseBlockMapping(state, indent) {
  const obj = {};
  const keys = [];

  while (state.pos < state.input.length) {
    skipWhitespaceAndComments(state);
    if (state.pos >= state.input.length) break;

    const lineIndent = currentIndent(state);
    if (lineIndent < indent) break;

    // Check for document end markers
    const rest = remaining(state);
    if (/^(---|\.\.\.)\s*(\n|$)/.test(rest)) break;

    const keyLine = state.line;
    const keyCol = state.col;

    // Parse key
    let key;
    const ch = peek(state);
    if (ch === '?') {
      advance(state);
      skipInlineWhitespace(state);
      key = String(parseValue(state, lineIndent + 1));
    } else {
      key = parseKeyString(state);
    }

    skipInlineWhitespace(state);
    if (peek(state) !== ':') {
      // Not a mapping key, treat as scalar
      break;
    }
    advance(state); // :
    skipInlineWhitespace(state);

    if (keys.includes(key)) {
      state.errors.push({ line: keyLine, col: keyCol, message: `Duplicate key: ${key}`, isDuplicateKey: true });
    }
    keys.push(key);

    // Parse value
    let val;
    if (peek(state) === '\n' || state.pos >= state.input.length) {
      // Value on next line(s)
      if (state.pos < state.input.length) advance(state); // skip \n
      skipWhitespaceAndComments(state);
      const nextIndent = currentIndent(state);
      if (nextIndent > lineIndent) {
        val = parseValue(state, nextIndent);
      } else {
        val = null;
      }
    } else {
      val = parseValue(state, lineIndent + 1);
    }

    obj[key] = val;

    // Skip to next line if needed
    skipInlineWhitespace(state);
    if (peek(state) === '#') skipToNextLine(state);
    if (peek(state) === '\n') advance(state);
  }

  return obj;
}

function parseKeyString(state) {
  if (peek(state) === '"') return parseDoubleQuoted(state);
  if (peek(state) === "'") return parseSingleQuoted(state);
  const start = state.pos;
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (ch === ':' && (state.input[state.pos + 1] === ' ' || state.input[state.pos + 1] === '\n' || state.pos + 1 >= state.input.length)) break;
    if (ch === '\n') break;
    advance(state);
  }
  return state.input.slice(start, state.pos).trim();
}

function parseBlockSequence(state, indent) {
  const items = [];
  while (state.pos < state.input.length) {
    skipWhitespaceAndComments(state);
    if (state.pos >= state.input.length) break;
    const lineIndent = currentIndent(state);
    if (lineIndent < indent) break;
    if (peek(state) !== '-') break;
    const rest = remaining(state);
    if (/^(---|\.\.\.)\s*(\n|$)/.test(rest)) break;
    advance(state); // -
    skipInlineWhitespace(state);
    if (peek(state) === '\n' || state.pos >= state.input.length) {
      if (state.pos < state.input.length) advance(state);
      skipWhitespaceAndComments(state);
      const nextIndent = currentIndent(state);
      items.push(parseValue(state, nextIndent));
    } else {
      items.push(parseValue(state, lineIndent + 2));
    }
    skipInlineWhitespace(state);
    if (peek(state) === '#') skipToNextLine(state);
    if (peek(state) === '\n') advance(state);
  }
  return items;
}

function parseScalar(state, _indent) {
  if (peek(state) === '"') return parseDoubleQuoted(state);
  if (peek(state) === "'") return parseSingleQuoted(state);
  if (peek(state) === '|' || peek(state) === '>') return parseBlockScalar(state, _indent);

  const start = state.pos;
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];
    if (ch === '\n') break;
    if (ch === '#' && (state.input[state.pos - 1] === ' ' || state.input[state.pos - 1] === '\t')) break;
    advance(state);
  }
  return coerce(state.input.slice(start, state.pos).trim());
}

function coerce(str) {
  if (str === 'true' || str === 'True' || str === 'TRUE') return true;
  if (str === 'false' || str === 'False' || str === 'FALSE') return false;
  if (str === 'null' || str === 'Null' || str === 'NULL' || str === '~') return null;
  if (str === '') return null;
  if (/^-?0x[0-9a-fA-F]+$/.test(str)) return parseInt(str, 16);
  if (/^-?0o[0-7]+$/.test(str)) return parseInt(str.replace('0o', ''), 8);
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(str)) return parseFloat(str);
  if (str === '.inf' || str === '.Inf' || str === '.INF') return Infinity;
  if (str === '-.inf' || str === '-.Inf' || str === '-.INF') return -Infinity;
  if (str === '.nan' || str === '.NaN' || str === '.NAN') return NaN;
  return str;
}

// ─── YAML Formatter (pretty-printer) ────────────────────────────────────────
function formatYaml(parsed, indentSize) {
  if (parsed === null || parsed === undefined) return 'null\n';
  return formatValue(parsed, 0, indentSize) + '\n';
}

function formatValue(val, depth, indentSize) {
  const ind = ' '.repeat(depth * indentSize);
  const childInd = ' '.repeat((depth + 1) * indentSize);
  if (val === null) return 'null';
  if (val === true) return 'true';
  if (val === false) return 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (/[\n:#\[\]{}&*?|>!,'"%@`]/.test(val) || /^\s/.test(val) || /\s$/.test(val) || val === '') {
      return JSON.stringify(val);
    }
    if (/^(true|false|null|yes|no|on|off|~|\d.*)$/i.test(val)) return JSON.stringify(val);
    return val;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return val.map(item => `${ind}- ${formatValue(item, depth + 1, indentSize)}`).join('\n');
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      const fv = formatValue(v, depth + 1, indentSize);
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
        return `${ind}${k}:\n${fv}`;
      }
      if (Array.isArray(v) && v.length > 0) {
        return `${ind}${k}:\n${fv}`;
      }
      return `${ind}${k}: ${fv}`;
    }).join('\n');
  }
  return String(val);
}

// ─── Schema Validation ───────────────────────────────────────────────────────
function loadSchema(schemaPath) {
  try {
    const content = readFileSync(schemaPath, 'utf8');
    const { documents } = parseYaml(content);
    return documents[0] || null;
  } catch (e) {
    return null;
  }
}

function validateSchema(data, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) return;

  const required = schema.required || [];
  const types = schema.types || {};
  const properties = schema.properties || {};

  for (const key of required) {
    if (data === null || data === undefined || !(key in data)) {
      errors.push({ type: 'error', message: `Required key missing: ${path ? path + '.' : ''}${key}` });
    }
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, typeSpec] of Object.entries(types)) {
      if (key in data) {
        const val = data[key];
        const expectedType = typeof typeSpec === 'string' ? typeSpec : typeSpec.type;
        const actualType = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
        if (expectedType && actualType !== expectedType) {
          errors.push({ type: 'error', message: `Key "${path ? path + '.' : ''}${key}": expected ${expectedType}, got ${actualType}` });
        }
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (data && key in data) {
        validateSchema(data[key], subSchema, `${path ? path + '.' : ''}${key}`, errors);
      }
    }
  }
}

// ─── Linting Rules ───────────────────────────────────────────────────────────
function lintLines(lines, opts) {
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Trailing whitespace
    if (opts.noTrailingSpaces && /[ \t]+$/.test(line)) {
      issues.push({ line: lineNum, col: line.trimEnd().length + 1, type: 'error', rule: 'no-trailing-spaces', message: 'Trailing whitespace' });
    }

    // Max line length
    if (opts.maxLineLength && line.length > opts.maxLineLength) {
      issues.push({ line: lineNum, col: opts.maxLineLength + 1, type: 'warning', rule: 'max-line-length', message: `Line length ${line.length} exceeds max ${opts.maxLineLength}` });
    }

    // Indent check (non-empty, non-comment lines)
    if (opts.indent && line.length > 0 && line[0] === ' ' && line.trimStart()[0] !== '#') {
      let spaces = 0;
      while (spaces < line.length && line[spaces] === ' ') spaces++;
      if (spaces % opts.indent !== 0) {
        issues.push({ line: lineNum, col: 1, type: 'warning', rule: 'indent', message: `Indentation ${spaces} is not a multiple of ${opts.indent}` });
      }
    }
  }

  // Require document start
  if (opts.requireDocumentStart && lines.length > 0 && lines[0].trimEnd() !== '---') {
    issues.push({ line: 1, col: 1, type: 'warning', rule: 'require-document-start', message: 'Document should start with ---' });
  }

  // Trailing newline
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    issues.push({ line: lines.length, col: 1, type: 'warning', rule: 'trailing-newline', message: 'File should end with a newline' });
  }

  return issues;
}

// ─── Auto-fix ────────────────────────────────────────────────────────────────
function fixContent(content, opts) {
  let lines = content.split('\n');

  // Fix trailing whitespace
  if (opts.noTrailingSpaces) {
    lines = lines.map(l => l.trimEnd());
  }

  // Fix trailing newline
  if (lines[lines.length - 1] !== '') lines.push('');

  // Fix indent (simple re-indent)
  if (opts.indent) {
    lines = lines.map(line => {
      if (line.length === 0) return line;
      let spaces = 0;
      while (spaces < line.length && line[spaces] === ' ') spaces++;
      const content = line.slice(spaces);
      if (!content || content[0] === '#') return line;
      // Round to nearest indent multiple
      const rounded = Math.round(spaces / opts.indent) * opts.indent;
      return ' '.repeat(rounded) + content;
    });
  }

  return lines.join('\n');
}

// ─── File Discovery ───────────────────────────────────────────────────────────
function collectFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    try {
      const stat = statSync(input);
      if (stat.isDirectory()) {
        collectFromDir(input, files);
      } else if (isYaml(input)) {
        files.push(input);
      }
    } catch (e) {
      files.push(input); // Will error on read, reported there
    }
  }
  return files;
}

function collectFromDir(dir, files) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) collectFromDir(full, files);
      else if (isYaml(full)) files.push(full);
    } catch {}
  }
}

function isYaml(f) {
  const ext = extname(f).toLowerCase();
  return ext === '.yaml' || ext === '.yml';
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────
const HELP = `
${c.bold('yaml-lint')} — Fast YAML validator, formatter, and linter (zero dependencies)

${c.bold('USAGE')}
  yaml-lint [options] <file|dir> [file|dir...]

${c.bold('OPTIONS')}
  --fix                    Auto-fix formatting issues
  --format                 Only reformat/prettify, don't lint
  --indent <n>             Required indent size (default: 2)
  --max-line-length <n>    Warn on lines longer than n chars (default: 120)
  --no-trailing-spaces     Error on trailing whitespace
  --require-document-start Require --- at document start
  --no-duplicate-keys      Error on duplicate keys
  --schema <file>          Validate against schema YAML file
  --json                   Output errors as JSON
  --watch                  Watch files and re-lint on change
  --color / --no-color     Force color on/off
  -h, --help               Show this help

${c.bold('EXIT CODES')}
  0  All files passed
  1  One or more errors found
  2  Warnings only (no errors)

${c.bold('EXAMPLES')}
  yaml-lint config.yaml
  yaml-lint --fix --indent 4 config.yaml
  yaml-lint --no-trailing-spaces --require-document-start src/
  yaml-lint --schema schema.yaml config.yaml
  yaml-lint --json config.yaml
  yaml-lint --watch src/

${c.bold('SCHEMA FILE FORMAT')} (YAML)
  required:
    - name
    - version
  types:
    name: string
    port: number
    enabled: boolean
`.trim();

function parseArgs(argv) {
  const opts = {
    files: [],
    fix: false,
    format: false,
    indent: 2,
    maxLineLength: 120,
    noTrailingSpaces: false,
    requireDocumentStart: false,
    noDuplicateKeys: false,
    schema: null,
    json: false,
    watch: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fix') opts.fix = true;
    else if (arg === '--format') opts.format = true;
    else if (arg === '--indent') opts.indent = parseInt(argv[++i], 10) || 2;
    else if (arg === '--max-line-length') opts.maxLineLength = parseInt(argv[++i], 10) || 120;
    else if (arg === '--no-trailing-spaces') opts.noTrailingSpaces = true;
    else if (arg === '--require-document-start') opts.requireDocumentStart = true;
    else if (arg === '--no-duplicate-keys') opts.noDuplicateKeys = true;
    else if (arg === '--schema') opts.schema = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--watch') opts.watch = true;
    else if (arg === '--no-color') process.env.NO_COLOR = '1';
    else if (arg === '--color') delete process.env.NO_COLOR;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (!arg.startsWith('--')) opts.files.push(arg);
  }
  return opts;
}

function lintFile(filePath, opts, schema) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) {
    return { filePath, error: `Cannot read file: ${e.message}`, issues: [], parseErrors: [] };
  }

  const lines = content.split('\n');
  const { documents, errors: parseErrors } = parseYaml(content);

  // Collect duplicate key errors only if flag set
  const filteredParseErrors = parseErrors.filter(e => {
    if (e.isDuplicateKey && !opts.noDuplicateKeys) return false;
    return true;
  });

  const lintIssues = opts.format ? [] : lintLines(lines, opts);

  // Schema validation
  const schemaIssues = [];
  if (schema && documents[0] !== undefined) {
    validateSchema(documents[0], schema, '', schemaIssues);
  }

  return {
    filePath,
    content,
    lines,
    parseErrors: filteredParseErrors,
    lintIssues,
    schemaIssues,
    document: documents[0],
  };
}

function printResults(results, opts) {
  const allIssues = [];

  for (const r of results) {
    const issues = [];

    if (r.error) {
      issues.push({ type: 'error', message: r.error, line: 1, col: 1 });
    }

    for (const e of (r.parseErrors || [])) {
      issues.push({ type: 'error', rule: 'parse', line: e.line, col: e.col, message: e.message });
    }
    for (const i of (r.lintIssues || [])) {
      issues.push(i);
    }
    for (const s of (r.schemaIssues || [])) {
      issues.push({ type: s.type || 'error', rule: 'schema', line: 0, col: 0, message: s.message });
    }

    allIssues.push({ file: r.filePath, issues });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(allIssues, null, 2) + '\n');
    return summarizeCodes(allIssues);
  }

  for (const { file, issues } of allIssues) {
    const rel = relative(cwd(), file);
    if (issues.length === 0) {
      console.log(`${c.green('✓')} ${c.bold(rel)}`);
    } else {
      console.log(`\n${c.bold(rel)}`);
      for (const issue of issues) {
        const loc = issue.line ? `${issue.line}:${issue.col || 1}` : '-';
        const tag = issue.type === 'error' ? c.red('error') : c.yellow('warn ');
        const rule = issue.rule ? c.dim(` [${issue.rule}]`) : '';
        console.log(`  ${c.dim(loc.padEnd(8))} ${tag}  ${issue.message}${rule}`);
      }
    }
  }

  return summarizeCodes(allIssues);
}

function summarizeCodes(allIssues) {
  let totalErrors = 0, totalWarnings = 0, totalFiles = allIssues.length;
  for (const { issues } of allIssues) {
    for (const i of issues) {
      if (i.type === 'error') totalErrors++;
      else totalWarnings++;
    }
  }
  return { totalFiles, totalErrors, totalWarnings };
}

function printSummary(stats, opts) {
  if (opts.json) return;
  const { totalFiles, totalErrors, totalWarnings } = stats;
  const fileWord = totalFiles === 1 ? 'file' : 'files';
  const errStr = totalErrors > 0 ? c.red(`${totalErrors} error${totalErrors !== 1 ? 's' : ''}`) : `0 errors`;
  const warnStr = totalWarnings > 0 ? c.yellow(`${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}`) : `0 warnings`;
  console.log(`\n${c.dim('─'.repeat(40))}`);
  console.log(`${c.bold(totalFiles)} ${fileWord} checked · ${errStr} · ${warnStr}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help || opts.files.length === 0) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const schema = opts.schema ? loadSchema(resolve(opts.schema)) : null;
  if (opts.schema && !schema) {
    console.error(c.red(`Cannot load schema: ${opts.schema}`));
    process.exit(1);
  }

  const files = collectFiles(opts.files.map(f => resolve(f)));
  if (files.length === 0) {
    console.error(c.yellow('No YAML files found.'));
    process.exit(0);
  }

  function runLint() {
    const results = files.map(f => lintFile(f, opts, schema));

    // Auto-fix
    if (opts.fix || opts.format) {
      for (const r of results) {
        if (!r.content) continue;
        const fixed = fixContent(r.content, opts);
        if (fixed !== r.content) {
          writeFileSync(r.filePath, fixed, 'utf8');
          if (!opts.json) console.log(`${c.cyan('fixed')} ${relative(cwd(), r.filePath)}`);
          r.content = fixed;
          // Re-parse for reporting
          const reResult = lintFile(r.filePath, opts, schema);
          Object.assign(r, reResult);
        }
      }
    }

    const stats = printResults(results, opts);
    printSummary(stats, opts);

    return stats;
  }

  if (opts.watch) {
    console.log(c.dim(`Watching ${files.length} file(s)... (Ctrl+C to stop)\n`));
    runLint();
    for (const f of files) {
      watchFile(f, { interval: 300 }, () => {
        console.clear();
        console.log(c.dim(`[${new Date().toLocaleTimeString()}] File changed: ${relative(cwd(), f)}\n`));
        runLint();
      });
    }
    return; // Keep process alive
  }

  const stats = runLint();

  if (stats.totalErrors > 0) process.exit(1);
  else if (stats.totalWarnings > 0) process.exit(2);
  else process.exit(0);
}

main().catch(e => {
  console.error(c.red(`Fatal: ${e.message}`));
  process.exit(1);
});
