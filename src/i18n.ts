/**
 * User-facing messages in English and Korean. Pick with OVERLEAF_LANG=en|ko (default en).
 * Low-level protocol errors and text coming from Overleaf or git are passed through untranslated.
 */

export type Lang = "en" | "ko";

const en = {
  // projects & paths
  noProject: () => "No project given. Pass `project` (ID or URL) or set OVERLEAF_PROJECT_ID.",
  nameNeedsWeb: (r: string) =>
    `"${r}" is not a project ID. Looking projects up by name needs the opt-in web mode (see README); pass the project ID or URL instead.`,
  noProjectNamed: (r: string) => `No project named "${r}". Use list_projects to see available projects.`,
  ambiguousProject: (r: string, list: string) => `"${r}" matches several projects; pass the ID instead:\n${list}`,
  noCredentials: () =>
    "No credentials configured. Set OVERLEAF_GIT_TOKEN (or opt in to web mode with OVERLEAF_ENABLE_WEB=1 and OVERLEAF_SESSION_COOKIE; see README).",
  zipFallbackFailed: (git: string, zip: string) => `${git}\nZip download fallback also failed: ${zip}`,
  invalidPath: (p: string) => `Invalid path: ${p}`,
  pathEscapes: (p: string) => `Path escapes the project: ${p}`,
  pathNotAllowed: (p: string) => `Path not allowed: ${p}`,
  fileNotFound: (p: string) => `File not found: ${p}`,
  binaryFile: (p: string) => `${p} is a binary file and cannot be read as text.`,
  notFoundInProject: (p: string) => `Not found in project: ${p}`,
  savedViaWeb: () => "Saved to Overleaf via the web editor (no Git). Use Overleaf's History to review or undo.",

  // git
  gitMissing: () => "git is not installed or not on PATH.",
  gitNoAccess: () =>
    "Overleaf Git integration needs the project owner to have a paid or institutional plan. Without it, the only alternative is the opt-in web mode; read the README for its risks first.",
  gitAuth: () => "Check OVERLEAF_GIT_TOKEN. Overleaf Git integration requires a paid plan (or institutional access).",
  gitResetRetry: (e: string) => `${e}\nLocal copy was reset to match Overleaf; please retry.`,
  gitNothingToCommit: () => "No changes to commit (file already had this content).",
  gitPushFailed: (e: string) => `Could not push to Overleaf; your change was NOT saved. ${e}`,
  gitPushed: (sha: string) => `Committed and pushed ${sha} to Overleaf.`,

  // web mode
  webOff: (feature: string) =>
    `${feature} needs web mode, which is off by default. Web mode uses Overleaf's internal web endpoints, which may violate Overleaf's Acceptable Use Policy and could get your account suspended. To use it at your own risk, set OVERLEAF_ENABLE_WEB=1 and OVERLEAF_SESSION_COOKIE. See the README.`,
  webNeedsCookie: (feature: string) =>
    `${feature} needs OVERLEAF_SESSION_COOKIE (your Overleaf browser session cookie). See the README.`,
  sessionExpired: () => "Overleaf session cookie is invalid or expired. Copy a fresh OVERLEAF_SESSION_COOKIE from your browser.",
  featListProjects: () => "Listing projects",
  featCompile: () => "Compiling",
  featComments: () => "Comments",
  featSettings: () => "Changing project settings",
  featOther: () => "This operation",

  // listing & reading
  noProjectsFound: () => "No projects found.",
  emptyProject: () => "(empty project)",
  lineRange: (file: string, start: number, end: number, total?: number) =>
    `[${file} lines ${start}-${end}${total === undefined ? "" : ` of ${total}`}]`,
  mainFile: (f?: string) => `Main file: ${f ?? "(not found)"}`,
  noHeadings: () => "No sectioning commands found.",
  noSection: (t: string) => `No section matching "${t}". Use get_outline to see section titles.`,
  ambiguousSection: (t: string, list: string) => `"${t}" matches several sections; be more specific or pass \`file\`:\n${list}`,

  // editing
  oldNotFound: (f: string) => `old_string not found in ${f}. Read the file again; it may have changed on Overleaf.`,
  oldAmbiguous: (n: number, f: string) =>
    `old_string occurs ${n} times in ${f}. Add surrounding context to make it unique, or set replace_all.`,
  replaced: (n: number, f: string, result: string) => `Replaced ${n} occurrence(s) in ${f}. ${result}`,
  deleted: (p: string, result: string) => `Deleted ${p}. ${result}`,
  deletedWeb: (folder: boolean, p: string) => `Deleted ${folder ? "folder" : "file"} ${p} on Overleaf (restorable from History).`,
  samePath: () => "path and new_path are the same.",
  alreadyExists: (p: string) => `${p} already exists.`,
  notAFolder: (p: string) => `${p} is a file, not a folder.`,
  moved: (from: string, to: string, result = "") => `Moved ${from} → ${to}${result ? `. ${result}` : " on Overleaf."}`,

  // markdown
  markdownSource: () => "Pass exactly one of `markdown` or `md_path`.",
  markdownTarget: () => "Pass `path` (target .tex file) or `section` (existing section to replace).",
  notTexTarget: (p: string) => `Target should be a .tex file, got ${p}`,
  mainFileOverwrite: (p: string) =>
    `${p} is the main file (it has \\documentclass); overwriting it would delete the preamble. Write to a separate file (e.g. sections/intro.tex and \\input it), replace a \`section\`, or use mode "append".`,
  planSection: (title: string, file: string, from: number, to: number, withHeading: boolean) =>
    `Replaced section "${title}" (${file} lines ${from}-${to})${withHeading ? " including its heading" : ""}`,
  planAppend: (p: string) => `Appended to ${p}`,
  planCreate: (p: string, existed: boolean) => `${existed ? "Overwrote" : "Created"} ${p}`,
  dryRun: (d: string) => `Dry run — would apply: ${d}`,
  planDone: (d: string, result: string) => `${d}. ${result}`,
  missingPackages: (pkgs: string) => `Note: the preamble does not load ${pkgs}; add it or compilation may fail.`,
  koreanSetupHint: () =>
    "Note: this text contains Korean. Korean documents need \\usepackage{kotex} and the XeLaTeX compiler; run setup_paper_language with language \"ko\".",

  // comments
  notEditableDoc: (p: string) => `${p} is not an editable text file in this project.`,
  passageNotFound: (p: string) => `Passage not found in ${p}. Read the file and copy the text exactly.`,
  passageAmbiguous: (n: number, p: string) => `Passage occurs ${n} times in ${p}; pass a longer passage or \`occurrence\`.`,
  onlyOccurrences: (n: number) => `Only ${n} occurrence(s) found.`,
  commentAdded: (where: string, text: string, thread: string) => `Added comment on ${where} "${text}" (thread ${thread}).`,
  noThread: (id: string) => `No comment thread ${id}. Use get_comments to list threads.`,
  threadNotAttached: (id: string) => `No comment thread ${id} is attached to any document.`,
  replied: (id: string) => `Replied to thread ${id}.`,
  resolved: (reopen: boolean, id: string) => `${reopen ? "Reopened" : "Resolved"} thread ${id}.`,
  noOpenComments: () => "No open comments.",
  resolvedTag: () => " (resolved)",
  threadLabel: (id: string) => `thread ${id}`,

  // compile
  compileStatus: (status: string, pdf: boolean) => `Status: ${status}${pdf ? " (PDF produced)" : " (no PDF)"}`,
  compileCounts: (e: number, w: number, b: number) => `Errors: ${e}, warnings: ${w}, bad boxes: ${b}`,
  compileTimeout: () => "The compile timed out. Try draft mode or check for heavy figures.",
  compileRateLimited: () => "Overleaf rate-limited this compile; wait a few seconds and retry.",
  errorsHeader: () => "Errors:",
  warningsHeader: () => "Warnings:",
  badboxesHeader: () => "Bad boxes:",
  logTailHeader: () => "Log tail:",
  noLog: () => "(No log file was returned.)",
  andMore: (n: number) => `- ... and ${n} more`,
  koreanCompileHint: () =>
    "Hint: the errors come from Korean characters. Run setup_paper_language with language \"ko\" to add \\usepackage{kotex} and switch the compiler to XeLaTeX.",
  noPdf: (status: string) => `Compile finished with status "${status}" and produced no PDF. Run compile to see errors.`,
  pdfSaved: (kb: string, p: string) => `Saved ${kb} KB PDF to ${p}`,

  // paper language
  koreanAlreadySet: (file: string) => `${file} already loads a Korean package (kotex or similar).`,
  kotexAdded: (file: string, result: string) => `Added \\usepackage{kotex} to ${file}. ${result}`,
  compilerSet: (compiler: string) => `Set the project compiler to ${compiler}.`,
  compilerManual: (compiler: string) =>
    `Set the compiler to ${compiler} yourself: Overleaf → Menu → Settings → Compiler (changing it from here needs web mode).`,
  englishSetup: () => "English needs no extra packages; pdfLaTeX (Overleaf's default) works.",
  noMainFile: () => "Could not find the main .tex file (the one with \\documentclass).",

  // startup
  startWebOn: () =>
    "mcp-overleaf: web mode is ON. It uses Overleaf's internal web endpoints, which are not a publicly supported interface and may violate Overleaf's Acceptable Use Policy; your account could be suspended. Use at your own risk.",
  startCookieIgnored: () =>
    "mcp-overleaf: OVERLEAF_SESSION_COOKIE is set but ignored because web mode is off (set OVERLEAF_ENABLE_WEB=1 to opt in).",
  startNoGit: () => "mcp-overleaf: warning: OVERLEAF_GIT_TOKEN is not set; only write_markdown dry runs will work.",
};

const ko: typeof en = {
  noProject: () => "프로젝트가 지정되지 않았습니다. `project`(ID 또는 URL)를 넘기거나 OVERLEAF_PROJECT_ID를 설정하세요.",
  nameNeedsWeb: (r) =>
    `"${r}"는 프로젝트 ID가 아닙니다. 이름으로 프로젝트를 찾으려면 선택 기능인 웹 모드가 필요합니다(README 참고). 프로젝트 ID나 URL을 넘겨 주세요.`,
  noProjectNamed: (r) => `"${r}"라는 이름의 프로젝트가 없습니다. list_projects로 프로젝트 목록을 확인하세요.`,
  ambiguousProject: (r, list) => `"${r}"와 일치하는 프로젝트가 여러 개입니다. ID를 넘겨 주세요:\n${list}`,
  noCredentials: () =>
    "인증 정보가 없습니다. OVERLEAF_GIT_TOKEN을 설정하세요(또는 OVERLEAF_ENABLE_WEB=1과 OVERLEAF_SESSION_COOKIE로 웹 모드를 켜세요. README 참고).",
  zipFallbackFailed: (git, zip) => `${git}\nzip 다운로드로 대체하는 것도 실패했습니다: ${zip}`,
  invalidPath: (p) => `잘못된 경로입니다: ${p}`,
  pathEscapes: (p) => `프로젝트 밖을 가리키는 경로입니다: ${p}`,
  pathNotAllowed: (p) => `허용되지 않는 경로입니다: ${p}`,
  fileNotFound: (p) => `파일이 없습니다: ${p}`,
  binaryFile: (p) => `${p}는 바이너리 파일이라 텍스트로 읽을 수 없습니다.`,
  notFoundInProject: (p) => `프로젝트에 없습니다: ${p}`,
  savedViaWeb: () => "웹 편집기를 통해 Overleaf에 저장했습니다(Git 아님). 확인하거나 되돌리려면 Overleaf의 History를 쓰세요.",

  gitMissing: () => "git이 설치되어 있지 않거나 PATH에 없습니다.",
  gitNoAccess: () =>
    "Overleaf Git 연동은 프로젝트 소유자가 유료 또는 기관 플랜이어야 쓸 수 있습니다. 그렇지 않으면 선택 기능인 웹 모드만 쓸 수 있으니, README에서 위험을 먼저 확인하세요.",
  gitAuth: () => "OVERLEAF_GIT_TOKEN을 확인하세요. Overleaf Git 연동은 유료 플랜(또는 기관 계정)이 필요합니다.",
  gitResetRetry: (e) => `${e}\n로컬 사본을 Overleaf와 같게 되돌렸습니다. 다시 시도하세요.`,
  gitNothingToCommit: () => "커밋할 변경이 없습니다(파일 내용이 이미 같습니다).",
  gitPushFailed: (e) => `Overleaf에 push하지 못했습니다. 변경 사항은 저장되지 않았습니다. ${e}`,
  gitPushed: (sha) => `커밋 ${sha}를 Overleaf에 push했습니다.`,

  webOff: (feature) =>
    `${feature}에는 웹 모드가 필요한데, 웹 모드는 기본으로 꺼져 있습니다. 웹 모드는 Overleaf 내부 웹 주소를 사용하므로 Overleaf 이용 정책(Acceptable Use Policy)에 어긋날 수 있고 계정이 정지될 수 있습니다. 위험을 감수하고 쓰려면 OVERLEAF_ENABLE_WEB=1과 OVERLEAF_SESSION_COOKIE를 설정하세요. README를 참고하세요.`,
  webNeedsCookie: (feature) => `${feature}에는 OVERLEAF_SESSION_COOKIE(Overleaf 브라우저 세션 쿠키)가 필요합니다. README를 참고하세요.`,
  sessionExpired: () => "Overleaf 세션 쿠키가 잘못되었거나 만료되었습니다. 브라우저에서 OVERLEAF_SESSION_COOKIE를 새로 복사하세요.",
  featListProjects: () => "프로젝트 목록 조회",
  featCompile: () => "컴파일",
  featComments: () => "댓글 기능",
  featSettings: () => "프로젝트 설정 변경",
  featOther: () => "이 작업",

  noProjectsFound: () => "프로젝트가 없습니다.",
  emptyProject: () => "(빈 프로젝트)",
  lineRange: (file, start, end, total) => `[${file} ${start}-${end}행${total === undefined ? "" : ` / 전체 ${total}행`}]`,
  mainFile: (f) => `메인 파일: ${f ?? "(찾지 못함)"}`,
  noHeadings: () => "섹션 명령(\\section 등)을 찾지 못했습니다.",
  noSection: (t) => `"${t}"와 일치하는 섹션이 없습니다. get_outline으로 섹션 제목을 확인하세요.`,
  ambiguousSection: (t, list) => `"${t}"와 일치하는 섹션이 여러 개입니다. 더 구체적으로 쓰거나 \`file\`을 지정하세요:\n${list}`,

  oldNotFound: (f) => `${f}에서 old_string을 찾지 못했습니다. Overleaf에서 바뀌었을 수 있으니 파일을 다시 읽으세요.`,
  oldAmbiguous: (n, f) => `old_string이 ${f}에 ${n}번 나옵니다. 앞뒤 문맥을 더 넣어 하나로 특정하거나 replace_all을 설정하세요.`,
  replaced: (n, f, result) => `${f}에서 ${n}곳을 바꿨습니다. ${result}`,
  deleted: (p, result) => `${p}를 삭제했습니다. ${result}`,
  deletedWeb: (folder, p) => `Overleaf에서 ${folder ? "폴더" : "파일"} ${p}를 삭제했습니다(History에서 복구 가능).`,
  samePath: () => "path와 new_path가 같습니다.",
  alreadyExists: (p) => `${p}가 이미 있습니다.`,
  notAFolder: (p) => `${p}는 폴더가 아니라 파일입니다.`,
  moved: (from, to, result = "") => `${from} → ${to}로 옮겼습니다.${result ? ` ${result}` : ""}`,

  markdownSource: () => "`markdown`과 `md_path` 중 하나만 넘겨 주세요.",
  markdownTarget: () => "`path`(대상 .tex 파일)나 `section`(교체할 기존 섹션)을 넘겨 주세요.",
  notTexTarget: (p) => `대상은 .tex 파일이어야 합니다: ${p}`,
  mainFileOverwrite: (p) =>
    `${p}는 메인 파일(\\documentclass가 있는 파일)이라 덮어쓰면 프리앰블이 사라집니다. 별도 파일에 쓰고(예: sections/intro.tex를 만들고 \\input으로 불러오기) \`section\`을 교체하거나, mode "append"를 쓰세요.`,
  planSection: (title, file, from, to, withHeading) =>
    `섹션 "${title}"(${file} ${from}-${to}행) ${withHeading ? "제목 포함 " : ""}교체`,
  planAppend: (p) => `${p} 끝에 추가`,
  planCreate: (p, existed) => `${p} ${existed ? "덮어쓰기" : "새로 만들기"}`,
  dryRun: (d) => `미리보기(적용 안 함): ${d}`,
  planDone: (d, result) => `${d} 완료. ${result}`,
  missingPackages: (pkgs) => `참고: 프리앰블에 ${pkgs}가 없습니다. 추가하지 않으면 컴파일이 실패할 수 있습니다.`,
  koreanSetupHint: () =>
    "참고: 한국어가 들어 있습니다. 한국어 문서는 \\usepackage{kotex}와 XeLaTeX 컴파일러가 필요합니다. setup_paper_language를 language \"ko\"로 실행하세요.",

  notEditableDoc: (p) => `${p}는 이 프로젝트에서 편집할 수 있는 텍스트 파일이 아닙니다.`,
  passageNotFound: (p) => `${p}에서 해당 문장을 찾지 못했습니다. 파일을 읽고 문장을 그대로 복사해 주세요.`,
  passageAmbiguous: (n, p) => `해당 문장이 ${p}에 ${n}번 나옵니다. 더 긴 문장을 넘기거나 \`occurrence\`를 지정하세요.`,
  onlyOccurrences: (n) => `${n}곳만 찾았습니다.`,
  commentAdded: (where, text, thread) => `${where} "${text}"에 댓글을 달았습니다(스레드 ${thread}).`,
  noThread: (id) => `댓글 스레드 ${id}가 없습니다. get_comments로 스레드 목록을 확인하세요.`,
  threadNotAttached: (id) => `댓글 스레드 ${id}가 어떤 문서에도 연결되어 있지 않습니다.`,
  replied: (id) => `스레드 ${id}에 답글을 달았습니다.`,
  resolved: (reopen, id) => `스레드 ${id}를 ${reopen ? "다시 열었습니다" : "해결 처리했습니다"}.`,
  noOpenComments: () => "열린 댓글이 없습니다.",
  resolvedTag: () => " (해결됨)",
  threadLabel: (id) => `스레드 ${id}`,

  compileStatus: (status, pdf) => `상태: ${status}${pdf ? " (PDF 생성됨)" : " (PDF 없음)"}`,
  compileCounts: (e, w, b) => `에러 ${e}개, 경고 ${w}개, 박스 경고 ${b}개`,
  compileTimeout: () => "컴파일 시간이 초과되었습니다. draft 모드를 쓰거나 무거운 그림을 확인하세요.",
  compileRateLimited: () => "Overleaf가 연속 컴파일을 제한했습니다. 몇 초 뒤 다시 시도하세요.",
  errorsHeader: () => "에러:",
  warningsHeader: () => "경고:",
  badboxesHeader: () => "박스 경고:",
  logTailHeader: () => "로그 끝부분:",
  noLog: () => "(로그 파일을 받지 못했습니다.)",
  andMore: (n) => `- ... 외 ${n}개`,
  koreanCompileHint: () =>
    "도움말: 한글 때문에 생긴 에러입니다. setup_paper_language를 language \"ko\"로 실행하면 \\usepackage{kotex}를 넣고 컴파일러를 XeLaTeX로 바꿉니다.",
  noPdf: (status) => `컴파일이 "${status}" 상태로 끝나 PDF가 만들어지지 않았습니다. compile로 에러를 확인하세요.`,
  pdfSaved: (kb, p) => `${kb} KB PDF를 ${p}에 저장했습니다`,

  koreanAlreadySet: (file) => `${file}에 이미 한국어 패키지(kotex 등)가 들어 있습니다.`,
  kotexAdded: (file, result) => `${file}에 \\usepackage{kotex}를 추가했습니다. ${result}`,
  compilerSet: (compiler) => `프로젝트 컴파일러를 ${compiler}로 바꿨습니다.`,
  compilerManual: (compiler) =>
    `컴파일러는 직접 ${compiler}로 바꿔 주세요: Overleaf → Menu → Settings → Compiler (여기서 바꾸려면 웹 모드가 필요합니다).`,
  englishSetup: () => "영어는 추가 패키지가 필요 없습니다. Overleaf 기본값인 pdfLaTeX로 컴파일됩니다.",
  noMainFile: () => "메인 .tex 파일(\\documentclass가 있는 파일)을 찾지 못했습니다.",

  startWebOn: () =>
    "mcp-overleaf: 웹 모드가 켜져 있습니다. 공개 지원 인터페이스가 아닌 Overleaf 내부 웹 주소를 사용하므로 Overleaf 이용 정책에 어긋날 수 있고 계정이 정지될 수 있습니다. 위험을 감수하고 사용하세요.",
  startCookieIgnored: () =>
    "mcp-overleaf: 웹 모드가 꺼져 있어 OVERLEAF_SESSION_COOKIE는 무시됩니다(켜려면 OVERLEAF_ENABLE_WEB=1).",
  startNoGit: () => "mcp-overleaf: 경고: OVERLEAF_GIT_TOKEN이 없어 write_markdown 미리보기만 동작합니다.",
};

const catalogs: Record<Lang, typeof en> = { en, ko };
let current: Lang = "en";

export function parseLang(value: string | undefined): Lang {
  return /^ko/i.test(value ?? "") ? "ko" : "en";
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** The message catalog for the current language: `t.noProject()`. */
export const t: typeof en = new Proxy({} as typeof en, {
  get: (_target, key: string) => catalogs[current][key as keyof typeof en],
});
