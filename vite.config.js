import { defineConfig } from "vite";

export default defineConfig({
  // 상대 경로로 빌드해야 dist/index.html 을 더블클릭(file://)해도 열린다.
  // 기본값 '/' 로 두면 file:// 에서 /assets/... 를 찾다가 실패한다.
  base: "./",
  server: { open: true }, // npm run dev 시 브라우저를 알아서 띄운다
});
