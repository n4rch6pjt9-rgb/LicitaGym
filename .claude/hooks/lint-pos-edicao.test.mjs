// Casos de teste do hook lint-pos-edicao.mjs. Rodar: node .claude/hooks/lint-pos-edicao.test.mjs
// (sem dependências, sem deno/ruff/bash reais; sai com código 1 se algum caso falhar).
import { arquivoParaLint, executarLint } from "./lint-pos-edicao.mjs";

const RAIZ = "/repo";
const edicao = (file_path, tool_name = "Edit", cwd = RAIZ) => ({ tool_name, tool_input: { file_path }, cwd });

// Caminho -> o que o hook deve devolver (relativo à raiz) ou null.
const recorte = [
  [edicao("/repo/supabase/functions/api-catmat/index.ts"), "supabase/functions/api-catmat/index.ts"],
  [edicao("/repo/supabase/functions/_shared/http.ts", "Write"), "supabase/functions/_shared/http.ts"],
  [edicao("/repo/supabase/functions/api-x/tela.tsx", "MultiEdit"), "supabase/functions/api-x/tela.tsx"],
  [edicao("/repo/tests/supabase/serpro_test.ts"), "tests/supabase/serpro_test.ts"],
  [edicao("/repo/services/coletor-externo/coletor/escopo.py"), "services/coletor-externo/coletor/escopo.py"],
  [edicao("/repo/scripts/saude_validar.py"), "scripts/saude_validar.py"],
  [edicao("supabase/functions/api-tenant/index.ts"), "supabase/functions/api-tenant/index.ts"], // caminho relativo ao cwd
  [edicao("../functions/_shared/http.ts", "Edit", "/repo/supabase/tests"), "supabase/functions/_shared/http.ts"],
  [edicao("/repo/supabase/functions/api-x/_shared_prod/http.ts"), null],
  [edicao("/repo/supabase/functions/a/b/_shared_prod/x.ts"), null], // o case do script atravessa "/"
  [edicao("/repo/supabase/migrations/20261112000000_x.sql"), null],
  [edicao("/repo/docs/operacao/matriz.md"), null],
  [edicao("/repo/README.md"), null],
  [edicao("/repo/scripts/ci/lint-alterados.sh"), null],
  [edicao("/fora/do/repo/x.py"), null],
  [edicao("/repo/../x.py"), null],
  [edicao("/repo/scripts/-rf.py"), null],
  [edicao(""), null],
  [{ tool_name: "Edit", tool_input: {}, cwd: RAIZ }, null],
  [{ tool_name: "Read", tool_input: { file_path: "/repo/scripts/a.py" }, cwd: RAIZ }, null],
  [{ tool_name: "Bash", tool_input: { command: "ruff check ." }, cwd: RAIZ }, null],
];

let falhas = 0;
for (const [entrada, esperado] of recorte) {
  const obtido = arquivoParaLint(entrada, RAIZ);
  if (obtido !== esperado) { falhas++; console.error("RECORTE:", JSON.stringify(entrada.tool_input), "esperado", esperado, "obtido", obtido); }
}

// Execução: o runner é simulado.
const ok = () => ({ status: 0, stdout: "deno lint (1 arquivo(s))\nChecked 1 file\n", stderr: "" });
const comErro = () => ({ status: 1, stdout: "error[no-unused-vars]: `x` is never used\n", stderr: "" });
const semBash = () => ({ error: Object.assign(new Error("spawn bash ENOENT"), { code: "ENOENT" }) });
const lento = () => ({ error: Object.assign(new Error("spawnSync bash ETIMEDOUT"), { code: "ETIMEDOUT" }) });
const gigante = () => ({ status: 1, stdout: "x".repeat(10_000), stderr: "" });

const casos = [
  ["lint ok não bloqueia nem fala", ok, (r) => r.codigo === 0 && r.mensagem === ""],
  ["lint com erro bloqueia (2) e traz a saída", comErro, (r) => r.codigo === 2 && r.mensagem.includes("no-unused-vars") && r.mensagem.includes("a.ts")],
  ["bash ausente não bloqueia", semBash, (r) => r.codigo === 0 && r.mensagem === ""],
  ["tempo esgotado não bloqueia, mas avisa", lento, (r) => r.codigo === 0 && r.mensagem.includes("ignorado")],
  ["saída enorme é cortada", gigante, (r) => r.codigo === 2 && r.mensagem.length < 4300 && r.mensagem.includes("[saída cortada]")],
];
for (const [nome, rodar, confere] of casos) {
  const r = executarLint("a.ts", RAIZ, rodar);
  if (!confere(r)) { falhas++; console.error("EXECUÇÃO:", nome, JSON.stringify(r).slice(0, 200)); }
}

// O script é chamado com bash, só o arquivo como argumento, na raiz, e com PULAR_SEM_FERRAMENTA=1.
let chamada = null;
executarLint("supabase/functions/api-x/index.ts", RAIZ, (cmd, args, opcoes) => { chamada = { cmd, args, opcoes }; return ok(); });
const chamadaOk = chamada && chamada.cmd === "bash" && chamada.args.length === 2 && chamada.args[0] === "scripts/ci/lint-alterados.sh" &&
  chamada.args[1] === "supabase/functions/api-x/index.ts" && chamada.opcoes.cwd === RAIZ && chamada.opcoes.env.PULAR_SEM_FERRAMENTA === "1" &&
  chamada.opcoes.timeout > 0;
if (!chamadaOk) { falhas++; console.error("CHAMADA do script fora do combinado:", JSON.stringify(chamada)); }

const total = recorte.length + casos.length + 1;
console.log(`${total - falhas}/${total} casos OK`);
process.exit(falhas ? 1 : 0);
