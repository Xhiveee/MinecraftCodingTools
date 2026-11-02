import { parseAnnotationsFromSource, stripComments, type Annotation, type ParsedJava, type ParsedMember, type ParsedParam } from "./javaparse.js";

const KOTLIN_JAVA_TYPES: Record<string, string> = {
  Any: "java.lang.Object", String: "java.lang.String", CharSequence: "java.lang.CharSequence",
  Boolean: "boolean", Byte: "byte", Char: "char", Short: "short", Int: "int", Long: "long", Float: "float", Double: "double", Unit: "void",
  List: "java.util.List", MutableList: "java.util.List", Set: "java.util.Set", MutableSet: "java.util.Set",
  Map: "java.util.Map", MutableMap: "java.util.Map", Collection: "java.util.Collection", Iterable: "java.lang.Iterable",
};
const KOTLIN_ARRAYS: Record<string, string> = { BooleanArray: "boolean[]", ByteArray: "byte[]", CharArray: "char[]", ShortArray: "short[]", IntArray: "int[]", LongArray: "long[]", FloatArray: "float[]", DoubleArray: "double[]" };
const KOTLIN_BOXED: Record<string, string> = { Boolean: "java.lang.Boolean", Byte: "java.lang.Byte", Char: "java.lang.Character", Short: "java.lang.Short", Int: "java.lang.Integer", Long: "java.lang.Long", Float: "java.lang.Float", Double: "java.lang.Double" };

function lineAt(source: string, at: number): number { return source.slice(0, at).split("\n").length; }

function balancedEnd(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      i = end < 0 ? source.length : end + 2;
    } else if (c === '"' || c === '\'') {
      const quote = c;
      for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === "\\") i++;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return source.length;
}

function classBodyStart(source: string, from: number): number {
  let parens = 0;
  let brackets = 0;
  for (let i = from; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      i = end < 0 ? source.length : end + 2;
    } else if (c === '"' || c === '\'') {
      const quote = c;
      for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === "\\") i++;
    } else if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (c === "[") brackets++;
    else if (c === "]") brackets = Math.max(0, brackets - 1);
    else if (c === "{" && parens === 0 && brackets === 0) return i;
    else if (c === "=" && parens === 0 && brackets === 0) return -1;
  }
  return -1;
}

/** Curly-brace depth at each character, ignoring strings. */
function braceDepths(source: string): Int32Array {
  const depths = new Int32Array(source.length);
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    depths[i] = depth;
    if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === '\'') {
      const quote = c;
      for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return depths;
}

function normalizeAnnotation(fragment: string): string {
  let out = fragment.replace(/@(field|property|get|set|param|setparam|delegate|receiver):/g, "@").replace(/::class\b/g, ".class");
  let result = "";
  let quote = "";
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (quote) {
      result += c;
      if (c === "\\") result += out[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (c === '"' || c === '\'') { quote = c; result += c; }
    else {
      const nested = /^(At|Slice|Constant)\s*\(/.exec(out.slice(i));
      if (nested && (i === 0 || !/[\w$]/.test(out[i - 1]!))) result += "@";
      result += c === "[" ? "{" : c === "]" ? "}" : c;
    }
  }
  out = result;
  return out;
}

function annotationsIn(prefix: string, problems: string[]): Annotation[] {
  const normalizedPrefix = prefix.replace(/@(field|property|get|set|param|setparam|delegate|receiver):/g, "@");
  const out: Annotation[] = [];
  for (let i = 0; i < normalizedPrefix.length; i++) {
    if (normalizedPrefix[i] !== "@" || normalizedPrefix.startsWith("@file:", i)) continue;
    const start = i;
    i++;
    while (i < normalizedPrefix.length && /[\w$.]/.test(normalizedPrefix[i]!)) i++;
    while (i < normalizedPrefix.length && /\s/.test(normalizedPrefix[i]!)) i++;
    if (normalizedPrefix[i] === "(") i = balancedEnd(normalizedPrefix, i, "(", ")");
    const fragment = normalizeAnnotation(normalizedPrefix.slice(start, i));
    try {
      const parsed = parseAnnotationsFromSource(fragment);
      if (parsed[0]) out.push(parsed[0]);
    } catch (e) {
      problems.push(`Line ${lineAt(prefix, start)}: Kotlin annotation could not be parsed (${(e as Error).message}).`);
    }
    i--;
  }
  return out;
}

function splitTopLevel(source: string): string[] {
  const out: string[] = [];
  let start = 0;
  const stack: string[] = [];
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      i = end < 0 ? source.length : end + 2;
    } else if (c === '"' || c === '\'') quote = c;
    else if ("(<[{".includes(c)) stack.push(c);
    else if (")>]}".includes(c)) stack.pop();
    else if (c === "," && !stack.length) { out.push(source.slice(start, i).trim()); start = i + 1; }
  }
  if (source.slice(start).trim()) out.push(source.slice(start).trim());
  return out;
}

function kotlinType(raw: string): string {
  let type = raw.trim().replace(/\s+/g, "").replace(/^(?:out|in)\b/, "");
  type = type.replace(/\?$/, "");
  if (KOTLIN_ARRAYS[type]) return KOTLIN_ARRAYS[type]!;
  const arr = /^Array<(.+)>$/.exec(type);
  if (arr) {
    let component = arr[1]!.replace(/\?$/, "");
    component = KOTLIN_BOXED[component] ?? KOTLIN_JAVA_TYPES[component] ?? component;
    return `${component}[]`;
  }
  const generic = /^([\w.]+)<.*>$/.exec(type);
  const name = generic?.[1] ?? type;
  const nullable = raw.trim().endsWith("?");
  const mapped = KOTLIN_JAVA_TYPES[name];
  if (nullable && KOTLIN_BOXED[name]) return KOTLIN_BOXED[name]!;
  return mapped ?? type;
}

function kotlinParam(raw: string, problems: string[]): ParsedParam | undefined {
  let equals = -1;
  const stack: string[] = [];
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' && raw.startsWith('"""', i)) {
      const end = raw.indexOf('"""', i + 3);
      i = end < 0 ? raw.length : end + 2;
    } else if (c === '"' || c === '\'') quote = c;
    else if ("(<[{".includes(c)) stack.push(c);
    else if (")>]}".includes(c)) stack.pop();
    else if (c === "=" && !stack.length) { equals = i; break; }
  }
  const value = (equals < 0 ? raw : raw.slice(0, equals)).trim();
  const colon = value.indexOf(":");
  if (colon < 0) return undefined;
  const name = value.slice(0, colon).replace(/^(?:crossinline|noinline|vararg|val|var)\s+/, "").replace(/^`|`$/g, "").trim();
  const annotationText = value.slice(0, colon);
  const annotations = annotationsIn(annotationText, problems);
  const type = value.slice(colon + 1).trim().replace(/\?\s*$/, (x) => x);
  return name && type ? { name, type: kotlinType(type), annotations } : undefined;
}

/** Lightweight Kotlin source parser for the annotation/signature surface used by Mixin validation. */
export function parseKotlin(source: string): ParsedJava {
  const s = stripComments(source);
  const problems: string[] = [];
  const pkg = /^\s*package\s+([\w.]+)/m.exec(s)?.[1] ?? "";
  const imports = new Map<string, string>();
  const wildcardImports: string[] = [];
  for (const m of s.matchAll(/^\s*import\s+([\w.]+)(\.\*)?(?:\s+as\s+(\w+))?/gm)) {
    if (m[2]) wildcardImports.push(m[1]!);
    else imports.set(m[3] ?? m[1]!.slice(m[1]!.lastIndexOf(".") + 1), m[1]!);
  }
  const classMatch = /\b(class|object|interface)\s+(`?[A-Za-z_$][\w$]*`?)/.exec(s);
  if (!classMatch) return { package: pkg, imports, wildcardImports, className: "", isInterface: false, classAnnotations: [], members: [], problems: ["No Kotlin class, object or interface declaration found."] };
  const classStart = classMatch.index;
  const className = classMatch[2]!.replace(/`/g, "");
  const beforeClass = s.slice(Math.max(s.lastIndexOf("}", classStart - 1), s.lastIndexOf("\n\n", classStart - 1)) + 1, classStart);
  const classAnnotations = annotationsIn(beforeClass, problems);
  const bodyStart = classBodyStart(s, classMatch.index + classMatch[0].length);
  if (bodyStart < 0) return { package: pkg, imports, wildcardImports, className: pkg ? `${pkg}.${className}` : className, isInterface: classMatch[1] === "interface", classAnnotations, members: [], problems: ["Kotlin class body was not found."] };
  const bodyEnd = balancedEnd(s, bodyStart, "{", "}") - 1;
  const depths = braceDepths(s);
  const members: ParsedMember[] = [];
  const declRe = /\b(fun|val|var)\s+(?:<[^>]+>\s*)?(`?[A-Za-z_$][\w$]*`?)/g;
  declRe.lastIndex = bodyStart + 1;
  let boundary = bodyStart + 1;
  for (let match = declRe.exec(s); match && match.index < bodyEnd; match = declRe.exec(s)) {
    const depth = depths[match.index] ?? 0;
    const nested = depth === 2 && s.lastIndexOf("companion object", match.index) > s.lastIndexOf("}", match.index);
    if (depth !== 1 && !nested) continue;
    const keyword = match[1]!;
    const name = match[2]!.replace(/`/g, "");
    const prefix = s.slice(boundary, match.index);
    const annotations = annotationsIn(prefix, problems);
    const modifiers = [...new Set([...(prefix.match(/\b(private|protected|public|internal|abstract|open|override|final|lateinit|suspend)\b/g) ?? []), ...(s.slice(Math.max(0, match.index - 40), match.index).includes("suspend") ? ["suspend"] : []), ...(annotations.some((a) => a.name === "JvmStatic") ? ["static"] : [])])];
    if (keyword === "fun") {
      const open = s.indexOf("(", declRe.lastIndex);
      if (open < 0 || open >= bodyEnd) { problems.push(`Line ${lineAt(s, match.index)}: Kotlin function ${name} has no parameter list.`); continue; }
      const close = balancedEnd(s, open, "(", ")") - 1;
      if (close < open) continue;
      const params = splitTopLevel(s.slice(open + 1, close)).map((p) => kotlinParam(p, problems)).filter((p): p is ParsedParam => !!p);
      let end = close + 1;
      while (end < bodyEnd && s[end] !== "{" && s[end] !== "\n" && s[end] !== "=") end++;
      let returnType = "Unit";
      const returnMatch = /:\s*([^\n={]+)/.exec(s.slice(close + 1, end));
      if (returnMatch) returnType = returnMatch[1]!.trim();
      if (s.slice(match.index, open).includes("suspend")) problems.push(`Line ${lineAt(s, match.index)}: suspend handler ${name} has a Continuation parameter in bytecode; signature checking is skipped.`);
      const memberEnd = s[end] === "{" ? balancedEnd(s, end, "{", "}") : s.indexOf("\n", end) < 0 ? bodyEnd : s.indexOf("\n", end);
      members.push({ kind: "method", name, type: kotlinType(returnType), params, modifiers, annotations, line: lineAt(s, match.index) });
      boundary = memberEnd;
      declRe.lastIndex = Math.max(declRe.lastIndex, boundary);
    } else {
      const tail = s.slice(declRe.lastIndex, bodyEnd);
      const typeMatch = /^\s*:\s*([^=\n;{]+)/.exec(tail);
      if (typeMatch) {
        members.push({ kind: "field", name, type: kotlinType(typeMatch[1]!), params: [], modifiers, annotations, line: lineAt(s, match.index) });
      } else if (annotations.length) {
        problems.push(`Line ${lineAt(s, match.index)}: property ${name} has no explicit type; Mixin member type checking is skipped.`);
      }
      const eol = s.indexOf("\n", declRe.lastIndex);
      boundary = eol < 0 ? bodyEnd : eol;
      declRe.lastIndex = Math.max(declRe.lastIndex, boundary);
    }
  }
  if (s.includes("companion object") && members.some((m) => !m.modifiers.includes("static") && m.annotations.some((a) => ["Inject", "Redirect", "ModifyArg", "ModifyVariable", "Accessor", "Invoker"].includes(a.name)))) {
    problems.push("Companion object mixin members require @JvmStatic to become static members on the enclosing class; verify the generated JVM bytecode.");
  }
  return { package: pkg, imports, wildcardImports, className: pkg ? `${pkg}.${className}` : className, isInterface: classMatch[1] === "interface", classAnnotations, members, problems };
}
