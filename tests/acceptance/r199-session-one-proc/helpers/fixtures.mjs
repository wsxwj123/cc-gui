// run.sh 在起实例之前跑一次:建临时 HOME、假命令行控制目录、claude 垫片。
import { buildFixtures, homeDir } from './lib.mjs';
buildFixtures();
console.log(`[r199] 夹具就绪:HOME=${homeDir()}`);
