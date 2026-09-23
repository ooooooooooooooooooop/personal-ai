/**
 * Irreversibility classification — body-independent.
 *
 * Answers one question for a guard: is this tool consequential at all, and does
 * its payload contain an irreversible operation (delete / overwrite / partition /
 * service-stop / process-kill)?
 *
 * WHY THIS LIVES IN host/: it knows no body. Its inputs are a canonical tool
 * name and a payload; its dictionaries are canonical tool names and command
 * words. host/ is already the home of body-independent world-model runtime
 * machinery (prediction.js, observation.js) and is zero-dependency by contract
 * (host/tests/firewall.test.js enforces it).
 *
 * Extracted verbatim from the DSH adapter's guard so in-repo bodies (pi) share
 * ONE copy instead of re-deriving security-critical detection. The DSH plugin
 * keeps its own copy: it deploys by copying a single file into a DSH profile
 * (dsh/world-model/cordis.patch.yml), so it cannot import host/. BCC-1 6.3
 * fixtures are what keep the two in agreement.
 *
 * Bias, the original author's and preserved: a false positive only demands
 * irreversible:true on a prediction (safe direction); a false negative is a
 * hole. Detection is deliberately wide.
 */

export function normToolName(n) {
  // 先去可执行后缀（.exe/.bat…），再把 -_ . / : 空白全切掉——
  // fs.write / fs_write / fs:write / FS.WRITE 归一到同一身份
  return String(n).toLowerCase().trim().replace(/\.(exe|com|bat|cmd|ps1)$/i, '').replace(/[-_\s./:]/g, '');
}
export const CONSEQUENT_TOOLS = new Set(['edit', 'write', 'str-replace-editor', 'str_replace_editor', 'notebook_edit', 'exec', 'mcp_call_tool', 'apply_patch', 'write_to_process', 'request_scope',
  // 跨 harness 常见别名——守卫集宁宽勿窄（不在 harness 里的名字无代价，
  // 在而没登记的 = 完全无守卫的变更通道）。
  'bash', 'shell', 'terminal', 'sh', 'powershell', 'pwsh', 'cmd', 'run', 'command',
  'run_command', 'run-command', 'execute', 'execute_command', 'execute-command',
  'run_terminal_command', 'shell_exec', 'editor', 'file_editor', 'file-editor',
  'str_replace', 'patch', 'create_file', 'delete_file', 'move_file', 'fs_write',
  'fs_edit', 'browser', 'computer', 'computer_use', 'mcp', 'call_tool', 'tool_call',
  'multi_edit', 'multiedit', 'multi-edit', 'call_mcp_tool', 'write_file', 'edit_file',
  'replace_in_file', 'rename_file', 'copy_file'].map(normToolName));
// 词根前缀：归一名以这些开头 = 命令执行/文件删除移动/GUI 动作类
export const CONSEQUENT_STEMS = ['exec', 'shell', 'bash', 'terminal', 'powershell', 'pwsh',
  'shellexec', 'runcommand', 'runterminal', 'run', 'mcp', 'calltool', 'toolcall', 'callmcp',
  'browser', 'computer', 'deletefile', 'movefile', 'createfile', 'writefile',
  'editfile', 'replaceinfile', 'renamefile', 'copyfile', 'patchfile', 'applypatch',
  'notebookedit', 'notebookwrite', 'strreplace', 'multiedit', 'editor',
  'texteditor', 'fs', 'os', 'sys', 'node', 'io', 'delete', 'move', 'rename',
  'kill'];
// 只读白名单：精确匹配归一名（非前缀！）——前缀匹配会把 read_exec/getshell/
// search_replace 这类变异/恶意命名放进免门区，等于在反转默认里重开一个
// 可枚举逃逸面。名字不在此表的 = consequential。不收录 printenv/whoami/echo。
// 注：裸 'find'/'get'/'fetch'/'skill' 不收——find -delete、get/fetch 落盘、
// skill 调技能包都可写，叫这个名字的 harness 工具不应免检（误伤方向=安全）。
export const SAFE_READONLY_TOOLS = new Set(['read', 'readfile', 'readtool', 'glob',
  'grep', 'search', 'findfilebyname', 'list', 'getoutput',
  'view', 'status', 'show', 'describe', 'cat', 'head', 'tail', 'ls', 'dir',
  'websearch', 'webfetch', 'codesearch', 'askuser', 'askuserquestion',
  'worldmodel', 'dshworldmodel', 'todowrite', 'notebookread',
  'resolve', 'exists', 'count', 'diff', 'inspect', 'readresource',
  'mcpreadresource', 'mcplisttools', 'mcplistservers', 'readsubagent',
  'getmanagedclaudesupervisor', 'listmanagedclaudesupervisors']);
/**
 * Resolve a body's tool name to its CANONICAL identity (BCC-1 6.4).
 *
 * A body may call a tool anything (`apply_patch` for `edit`), but the canonical
 * identity must stay stable: policy reasons about ROLES, not about one body's
 * vocabulary. Without this, a body's own tools fall through to the fail-safe
 * default below (consequential AND irreversible-by-default) — so every call to
 * a new body's tooling would demand an `irreversible:true` prediction, which is
 * safe but unusable.
 *
 * `aliases` is the BODY's declaration — { <body tool name>: <canonical name> }.
 * The canonical vocabulary is this module's dictionaries; a body adds names to
 * it, never redefines it. Passing no aliases keeps the previous behaviour
 * exactly (normToolName only).
 */
export function resolveToolId(name, aliases = null) {
  if (!aliases) return normToolName(name);
  const raw = String(name ?? '');
  const hit = aliases[raw] ?? aliases[normToolName(raw)];
  return normToolName(hit ?? raw);
}

export function isConsequential(name, aliases = null) {
  const tn = resolveToolId(name, aliases);
  if (!tn) return true;   // 无名工具不可绑定预测 → 按 consequential 挡（fail closed）
  if (CONSEQUENT_TOOLS.has(tn) || CONSEQUENT_STEMS.some(st => tn.startsWith(st))) return true;
  return !SAFE_READONLY_TOOLS.has(tn);   // 未知 = consequential（反转默认）
}
// 可逆编辑类（VCS 下可回滚）保持检测层；其余 consequential 一律
// default-irreversible——未知变更通道必须带 irreversible:true 预测。
export const REVERSIBLE_EDIT_TOOLS = new Set(['edit', 'write', 'strreplaceeditor',
  'notebookedit', 'applypatch', 'fswrite', 'fsedit', 'strreplace', 'multiedit',
  'writefile', 'editfile', 'replaceinfile', 'renamefile', 'copyfile',
  'createfile', 'patchfile', 'patch', 'editor', 'fileeditor', 'texteditor',
  'fseditfile']);
// 默认不可逆：参数=任意命令/远端调用/权限申请/GUI动作/删除移动的通道，载荷不可
// 静态证安全 → 一律要求 irreversible:true 预测。扫描器在此之下只剩纵深意义。
// 文件编辑类（edit/write/patch/fs_write）保持检测层——VCS 下可回滚。
export const IRREVERSIBLE_BY_DEFAULT = new Set(['exec', 'mcp_call_tool', 'write_to_process', 'request_scope',
  'bash', 'shell', 'terminal', 'sh', 'powershell', 'pwsh', 'cmd', 'run', 'command',
  'run_command', 'run-command', 'execute', 'execute_command', 'execute-command',
  'run_terminal_command', 'shell_exec', 'mcp', 'call_tool', 'tool_call',
  'delete_file', 'move_file', 'browser', 'computer', 'computer_use', 'multi_edit'].map(normToolName));
export const IRREVERSIBLE_STEMS = ['exec', 'shell', 'bash', 'terminal', 'powershell', 'pwsh',
  'shellexec', 'runcommand', 'runterminal', 'mcp', 'calltool', 'toolcall', 'callmcp',
  'browser', 'computer', 'deletefile', 'movefile'];
export function isIrreversibleByDefault(name, aliases = null) {
  const tn = resolveToolId(name, aliases);
  if (IRREVERSIBLE_BY_DEFAULT.has(tn) || IRREVERSIBLE_STEMS.some(st => tn.startsWith(st))) return true;
  // 未知 consequential 工具 = 不可证可逆 → default-irreversible（N11 对称反转）
  return isConsequential(name, aliases) && !REVERSIBLE_EDIT_TOOLS.has(tn);
}
// 多工具枚举检测词典：只数会受守卫约束的名字——ia 'exec ls' 里的 ls 是
// 命令参数不是被授权的工具；只读名本就不在门内，计数反而批发误伤。
export const TOOL_LEXICON = new Set([...CONSEQUENT_TOOLS, ...IRREVERSIBLE_BY_DEFAULT, ...REVERSIBLE_EDIT_TOOLS]);
// 不可逆判定（宽检测、安全方向偏向）：arguments 全部字符串值展平 → unicode 归一
// （全角/长短破折号→-，弯引号→'，驼峰边界断词）→ 按空白+shell 元字符+路径分隔
// 切词（管道/分号/$(…)/重定向/路径段都断词）→ 剥引号 → flag 归一 → basename/
// 版本号/.exe 归一 → 全位置签名扫描。
// 误报 = 仅要求 prediction 带 irreversible:true（安全方向）；漏报 = 漏洞。
export function flattenStrings(v, acc) {
  if (v == null) return acc;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') acc.push(String(v));
  else if (Array.isArray(v)) for (const x of v) flattenStrings(x, acc);
  // key 也展平——藏在对象键里的命令同样要过扫描（{rm:'-rf /'} 形态）
  else if (t === 'object') for (const k of Object.keys(v)) { acc.push(k); flattenStrings(v[k], acc); }
  return acc;
}
// 值限定版：绑定词表只用值（键名是结构不是载荷）；键名藏命令由 walkCmd 兜住
export function flattenVals(v, acc) {
  if (v == null) return acc;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') acc.push(String(v));
  else if (Array.isArray(v)) for (const x of v) flattenVals(x, acc);
  else if (t === 'object') for (const k of Object.keys(v)) flattenVals(v[k], acc);
  return acc;
}
export const CMD_WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'watch', 'xargs', 'parallel', 'command', 'exec', 'start', 'runas', 'busybox', 'sshpass', 'stdbuf', 'strace', 'ltrace', 'unbuffer', 'expect', 'ssh', 'wsl']);
// 内联代码解释器：-c/-e/-Command/-EncodedCommand/-m/-jar 等 → 载荷不可静态证安全 → 必标
export const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript', 'mshta', 'rundll32', 'regsvr32', 'installutil', 'wscript', 'cscript', 'wmic', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'powershell', 'pwsh', 'cmd', 'eval', 'source', 'iex', 'invoke-expression', 'groovy', 'jjs', 'irb', 'java', 'rscript', 'msbuild', 'dotnet', 'forfiles', 'nc', 'ncat', 'netcat', 'go']);
// 裸用即破坏的命令（删/覆写/擦除/分区/服务/进程终止）
export const DESTRUCTIVE_CMDS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'ri', 'unlink', 'shred', 'srm', 'wipe', 'sdelete', 'wipefs', 'remove-item', 'clear-content', 'set-content', 'rimraf', 'format', 'dd', 'diskpart', 'sfdisk', 'shutdown', 'reboot', 'poweroff', 'halt', 'init', 'telinit', 'fdisk', 'parted', 'bcdedit', 'vssadmin', 'wevtutil', 'fsutil', 'chattr', 'tee', 'truncate', 'mv', 'robocopy', 'cipher', 'kill', 'pkill', 'taskkill', 'umount', 'swapoff', 'rmmod', 'modprobe', 'setenforce', 'takeown', 'icacls', 'attrib', 'passwd', 'userdel', 'groupdel', 'stop-service', 'remove-service', 'restart-computer',
  // PowerShell verb-noun 矩阵补全 + 系统变更补充
  'stop-computer', 'stop-process', 'clear-disk', 'format-volume', 'move-item',
  'copy-item', 'rename-item', 'out-file', 'add-content', 'new-item',
  'set-item', 'set-itemproperty', 'new-itemproperty', 'remove-itemproperty',
  'invoke-command', 'enter-pssession', 'start-process', 'set-executionpolicy',
  'invoke-wmimethod', 'remove-wmiobject', 'remove-psdrive', 'clear-eventlog',
  'remove-eventlog', 'set-mppreference', 'set-service', 'new-service',
  'restart-service', 'reset-computermachinepassword', 'disable-computerrestore',
  'mke2fs', 'mkfs.ext4', 'insmod', 'swapon', 'setsebool', 'usermod',
  'sysctl', 'tskill', 'fuser', 'sshd', 'timedatectl', 'hostname',
  'useradd', 'groupadd', 'visudo', 'ansible-playbook', 'socat', 'pkexec',
  'docker-compose', 'ip6tables', 'nft', 'ebtables', 'ifconfig', 'drush']);
// host 工具 + 危险子命令矩阵
export const HOST_TOOLS = new Set(['git', 'docker', 'podman', 'nerdctl', 'buildah', 'kubectl', 'terraform', 'npm', 'pip', 'pip3', 'yarn', 'pnpm', 'apt', 'apt-get', 'dnf', 'pacman', 'zypper', 'snap', 'flatpak', 'winget', 'choco', 'scoop', 'gem', 'cargo', 'composer', 'brew', 'helm', 'redis-cli', 'mongo', 'mongosh', 'mysql', 'psql', 'sqlite3', 'az', 'aws', 'gcloud', 'sc', 'schtasks', 'reg', 'dism', 'netsh', 'net', 'iptables', 'ufw', 'systemctl', 'find', 'sed', 'perl', 'awk', 'chmod', 'chown', 'mv', 'cp', 'copy', 'move', 'xcopy', 'svn', 'hg', 'p4', 'crontab', 'at', 'cmdkey', 'gpg', 'rsync', 'rclone', 'curl', 'wget', 'certutil', 'bitsadmin', 'scp', 'msiexec', 'tar', 'unzip', 'virsh', 'drush']);
export const DANGER_SUBS = new Set(['delete', 'destroy', 'prune', 'uninstall', 'unpublish', 'publish', 'flushall', 'flushdb', 'flush', 'remove', 'purge', 'drop', 'truncate', 'reset', 'clean', 'cleanup', 'restore', 'expire', 'clear', 'disable', 'stop', 'kill', 'terminate', 'wipe', 'create', 'add', 'config', 'poweroff', 'reboot', 'shutdown', 'undefine', 'strip', 'autoremove', 'apply', 'drain', 'rmi', 'rb', 'erase',
  // 包安装/容器执行/远程拉取 = 任意代码执行面（scoped：仅当 host 词同现）
  'install', 'require', 'i', 'ci', 'run', 'exec', 'start', 'up', 'login', 'pull', 'load', 'import',
  'down', 'build', 'push', 'deploy', 'eval', 'script', 'command']);
// LOLBin：任意参数形态都可执行代码/拉取载荷——存在即标
export const LOLBINS = new Set(['mshta', 'regsvr32', 'rundll32', 'msiexec', 'javaws', 'wscript', 'cscript', 'hh', 'installutil', 'regasm', 'regsvcs', 'pcalua', 'url.dll', 'msbuild', 'dnx', 'rcsi', 'csi']);
export const SCRIPT_EXTS = new Set(['py', 'js', 'mjs', 'cjs', 'sh', 'ps1', 'bat', 'cmd', 'rb', 'pl', 'php', 'lua', 'vbs', 'vbe', 'hta', 'jar', 'exe', 'dll', 'wsf', 'reg', 'inf', 'txt']);
// 长 flag → 等效短 flag 字符（归一后走同一 has() 检查）
export const LONG_FLAG_ALIASES = { 'in-place': 'i', inplace: 'i', recursive: 'r', force: 'f',
  extract: 'x', overwrite: 'o', output: 'o', delete: 'd', expire: 'e', quiet: 'q',
  'all': 'a', 'yes': 'y', 'no-preserve-root': '', 'interactive': 'i' };
// basename/版本/后缀归一：python3.11 / python.exe / /usr/bin/python3 → python
export function normWord(w) { return w.replace(/\.(exe|com|dll)$/i, '').replace(/[\d.]+$/, ''); }
// 命令面键：这些键名下的字符串按"可执行内容"绑定（不只 token 重叠）
export const CMD_ARG_KEYS = new Set(['command', 'cmd', 'script', 'code', 'commandline', 'command_line', 'cmdline', 'shell', 'run', 'exec', 'argv', 'args', 'arguments', 'input_line', 'stdin', 'program', 'executable', 'file', 'path', 'file_path', 'filepath', 'target', 'url', 'uri']);
// 命令词表：词头落在其中 = 命令面字符串（与扫描器共享同一份语义）
export const CMD_HEAD_LEX = new Set([...INTERPRETERS, ...DESTRUCTIVE_CMDS, ...CMD_WRAPPERS, ...HOST_TOOLS]);
// execution 上的结构性自有键——参数载体之外的元数据不参与绑定词表
export const EXEC_STRUCT_KEYS = new Set(['name', 'arguments', 'args', 'params', 'input', 'parameters', 'payload', 'tool_input', 'agent', 'session']);
// 参数切词器（守卫绑定与扫描器共用同一 token 视图——防止两处语义漂移）
export function scanTokens(args) {
  const raw = flattenStrings(args, []);
  const norm = s => s.replace(/[‐‑‒–—―−﹘﹣－]/g, '-').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/([a-z])(?=[A-Z])/g, '$1 ');
  const rawJoined = raw.map(norm).join(' ').toLowerCase();
  const toks = raw
    .map(norm)
    // bash 转义拼接 'r\m'→'rm'：剥掉 \ 转义符再切词，否则 rm 永不形成
    .map(s => s.replace(/\\(.)/g, '$1'))
    .flatMap(s => s.split(/(\s+|[;&|(){}<>`$\/\\.,=:_]|\n)/))
    // 全量剥引号（不只两端）：'r''m' → rm
    .map(s => s.replace(/["'`]/g, '').toLowerCase())
    .filter(Boolean);
  const flagChars = new Set(), flagWords = new Set(), words = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^--[a-z][a-z0-9-]*/i.test(t)) flagWords.add(t.slice(2));
    else if (/^-[a-z]{4,}/i.test(t)) flagWords.add(t.slice(1));
    else if (/^-[a-z]/i.test(t)) for (const c of t.slice(1)) flagChars.add(c);
    else if (/^\/[a-z]$/i.test(t)) flagChars.add(t.slice(1));
    else if (/^\/[a-z][a-z0-9:=.]*$/i.test(t)) flagWords.add(t.slice(1));
    else words.push(t);
  }
  return { raw, rawJoined, toks, flagChars, flagWords, words };
}
export function isIrreversibleArgs(args) {
  const st = scanTokens(args);
  if (!st.raw.length) return false;
  const { rawJoined, toks, flagChars, flagWords, words } = st;
  if (!toks.length) {
    // 全是元字符也危险：fork bomb ':(){:|:&};:' 类
    return /:\s*\(\s*\)\s*\{[^}]*[:|]/.test(rawJoined);
  }
  // ANSI-C/hex 转义载荷（bash $'\x72\x6d…'）→ 静态不可证 → 必标
  if (/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\0[0-7]/i.test(rawJoined)) return true;
  // 命令替换 $(cmd) / `cmd` → 内嵌执行不可静态证安全 → 必标
  if (/\$\s*\(|`/.test(rawJoined)) return true;
  // fork bomb / 函数定义注入
  if (/:\s*\(\s*\)\s*\{/.test(rawJoined)) return true;
  // 环境变量前缀 FOO=bar cmd：赋值 token 不挡后续命令词（全位置扫描已覆盖，
  // 此条只兜底 '$CMD -rf' 式纯变量调用——flags 集合留档即可）
  // flag 集合已由 scanTokens 提供；此处只保留重定向/管道扫描
  let sawRedirect = false, pipeToInterp = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '>' || t === '<') { sawRedirect = true; continue; }
    if (t === '|' || t === '|&') {
      // 管道目标穿包装检测：curl x | sudo sh / | env sh —— wrapper 后面才是真命令
      let k = i + 1;
      while (k < toks.length && (CMD_WRAPPERS.has(toks[k]) || CMD_WRAPPERS.has(normWord(toks[k])))) k++;
      if (k < toks.length && INTERPRETERS.has(normWord(toks[k]))) pipeToInterp = true;
      continue;
    }
  }
  // 长 flag 语义归一：--in-place→i、--recursive→r、--force→f 等，
  // 否则 sed --in-place / tar --extract / chmod --recursive 漏检
  for (const w of flagWords) {
    const c = LONG_FLAG_ALIASES[w];
    if (c) flagChars.add(c);
  }
  if (sawRedirect || pipeToInterp) return true;
  const has = (...cs) => cs.some(c => flagChars.has(c) || flagWords.has(c));
  const forceWord = [...flagWords].some(w => w.startsWith('force'));
  const hasWord = (...ws) => words.some(w => ws.includes(w) || ws.includes(normWord(w)));
  const hasDangerSub = [...words, ...flagWords].some(w => DANGER_SUBS.has(w) || DANGER_SUBS.has(normWord(w)));
  const hasHost = words.some(w => HOST_TOOLS.has(w) || HOST_TOOLS.has(normWord(w)));
  if (hasHost && hasDangerSub) return true;
  // eval/source/iex 带任何参数 = 直接执行 → 必标
  if (hasWord('eval', 'source', 'iex', 'invoke-expression')) return true;
  // 解释器内联代码（python -c / node -e / powershell -Command/-EncodedCommand / sh -c / cmd /c / java -jar / python -m）
  const hasInterp = words.some(w => INTERPRETERS.has(w) || INTERPRETERS.has(normWord(w)));
  if (hasInterp && has('c', 'e', 'm', 'command', 'encodedcommand', 'enc', 'encoded', 'jar', 'f', 'k', 'file', 'eval', 'i')) return true;
  // 解释器+脚本文件（python x.py / node app.js）：'.' 是切词符 →
  // 'script.py' 裂成 script,.,py——必须重组 toks 检测，此条曾是死代码。
  if (hasInterp) {
    for (let i = 0; i + 2 < toks.length; i++) {
      if (toks[i + 1] === '.' && SCRIPT_EXTS.has(toks[i + 2])) return true;
    }
    // 解释器带任何非 flag 实参（python anything / sh script）——无法证安全
    if (words.some((w, i) => (INTERPRETERS.has(w) || INTERPRETERS.has(normWord(w)))
        && words.slice(i + 1).some(x => !CMD_WRAPPERS.has(x) && !INTERPRETERS.has(x)))) return true;
  }
  // LOLBin 任意调用形态
  if (words.some(w => LOLBINS.has(w) || LOLBINS.has(normWord(w)))) return true;
  // ssh/wsl 通道（ssh 在 CMD_WRAPPERS 会被跳过自身检查，隧道/远程执行要单独标）
  if (hasWord('ssh', 'wsl', 'scp', 'sftp', 'mosh')) return true;
  // 无歧义系统态变更命令（任何位置出现即标；常见英文词 at/ln/su/env 不收——
  // 全位置匹配会误报普通文本，且 exec 通道本就 default-irreversible 兜底）
  if (hasWord('crontab', 'schtasks', 'systemctl', 'mount', 'dpkg', 'rpm',
      'chroot', 'unshare', 'nsenter', 'setpriv', 'newgrp', 'busybox',
      'killall', 'pkill', 'useradd', 'groupadd', 'visudo', 'firewall-cmd',
      'launchctl', 'diskutil', 'nvram', 'efibootmgr')) return true;
  // git 子命令矩阵（-c 选项值隔着也扫得到——按词不按位）
  if (hasWord('git')) {
    if (hasWord('push') && (has('f', 'd', 'delete', 'mirror') || forceWord || words.some(w => w.startsWith('+')) || /[\s+]:[a-z0-9]/i.test(rawJoined))) return true;
    if (hasWord('reset') && hasWord('hard')) return true;
    if (hasWord('clean') || hasWord('restore') || hasWord('filter-branch') || hasWord('filter-repo') || hasWord('prune')) return true;
    if (hasWord('rebase') || hasWord('deinit') || hasWord('symbolic-ref')) return true;
    if (hasWord('checkout', 'switch') && (has('f') || hasWord('--'))) return true;
    if (hasWord('commit') && has('amend')) return true;
    if (hasWord('branch', 'update-ref', 'tag') && has('d')) return true;
    if (hasWord('reflog') && hasWord('expire', 'delete')) return true;
    if (hasWord('gc') && [...flagWords].some(w => w.startsWith('prune'))) return true;
    if (hasWord('stash') && hasWord('clear', 'drop')) return true;
    if (hasWord('worktree', 'remote') && hasWord('remove', 'prune')) return true;
    if (hasWord('rm') && has('r', 'f', 'cached')) return true;
  }
  for (let j = 0; j < words.length; j++) {
    const cmd = words[j], ncmd = normWord(cmd), sub = words[j + 1], nsub = sub && normWord(sub);
    if (CMD_WRAPPERS.has(cmd) || CMD_WRAPPERS.has(ncmd)) continue;
    if (DESTRUCTIVE_CMDS.has(cmd) || DESTRUCTIVE_CMDS.has(ncmd) || cmd.startsWith('mkfs')) return true;
    if (cmd.includes('rmtree') || cmd.startsWith('drop') || cmd.startsWith('delete') || cmd.startsWith('destroy')) return true;
    if ((INTERPRETERS.has(cmd) || INTERPRETERS.has(ncmd)) && sub && (SCRIPT_EXTS.has(sub) || SCRIPT_EXTS.has(nsub) || sub === '-')) return true;
    if ((cmd === 'sed' || cmd === 'perl' || cmd === 'awk' || cmd === 'find') && has('i', 'delete', 'exec', 'fprintf', 'f')) return true;
    if ((cmd === 'cp' || cmd === 'copy' || cmd === 'move' || cmd === 'xcopy' || cmd === 'scp') && (has('f', 'y') || hasWord('/dev/null') || words.length - j >= 3)) return true;
    if ((cmd === 'tar') && has('x', 'w', 'o')) return true;
    if ((cmd === 'unzip' || cmd === 'expand') && has('o', 'f', 'd')) return true;
    if ((cmd === 'curl' || cmd === 'wget' || cmd === 'certutil' || cmd === 'bitsadmin') && (has('o', 'output', 'outfile', 'urlcache', 'decode', 'transfer', 'remote-name') || sawRedirect)) return true;
    if ((cmd === 'chmod' || cmd === 'chown') && (has('r') || hasWord('000', '0000', '777'))) return true;
    if (cmd === 'iptables' || cmd === 'netsh' || cmd === 'ufw') {
      if (has('f', 'x', 'd') || hasWord('flush', 'off', 'delete', 'reset', 'disable')) return true;
    }
    if (cmd === 'drop' || cmd === 'truncate') return true;
  }
  return false;
}

/**
 * Does a learned overlay relax this call? (finding G11)
 *
 * The built-in dictionaries are the PRIOR — they always decide first. This
 * function is consulted only when the prior already says "irreversible", and it
 * can only RELAX that verdict. It can never tighten, and it can never touch a
 * call the prior already considers safe. There is deliberately no
 * "default: reversible" switch: the prior cannot be disabled wholesale.
 *
 * `overlay` is the compiled artifact (<canonicalDir>/reversibility.json),
 * already checked for freshness by the caller — a stale overlay must be dropped
 * wholesale, never partially applied.
 *
 * LIMITATION, stated rather than hidden: `scope_conditions` are declarative
 * prose ("headless DSH session"). The compiler REQUIRES them so a reviewer sees
 * the scope, but this function cannot evaluate them — scope is enforced by
 * review at compile time, not at run time. Freshness, by contrast, IS enforced
 * at run time.
 *
 * @param {object|null} overlay
 * @param {string} toolName
 * @param {unknown[]} pool  the payload pool the prior scanned
 * @returns {boolean} true when a relaxation matches and the prior verdict should be dropped
 */
export function overlayRelaxes(overlay, toolName, pool) {
  const rels = overlay?.relaxations;
  if (!Array.isArray(rels) || !rels.length) return false;
  const tn = normToolName(toolName);
  // Command heads: the first non-flag token of any command-looking string.
  const heads = new Set();
  for (const s of flattenStrings(pool, [])) {
    for (const raw of String(s).split(/[\s;&|()<>]+/)) {
      const t = raw.trim().replace(/^['"]|['"]$/g, '');
      if (!t || t.startsWith('-')) continue;
      heads.add(normWord(t.toLowerCase()));
    }
  }
  for (const r of rels) {
    if (r?.class !== 'reversible') continue;   // only relaxations are representable
    const m = r?.match;
    if (!m || normToolName(m.tool) !== tn) continue;
    if (m.command_head && !heads.has(normWord(String(m.command_head).toLowerCase()))) continue;
    return true;
  }
  return false;
}
