import { describe, expect, it } from 'vitest';
import { checkRedisCommand, checkSubmissionSql, splitStatements } from '../../src/exec/guards.js';
import { tokenizeRedis } from '../../src/exec/redis.js';

/**
 * 守卫层是纯函数，放宿主机跑（判题 runner 套件要容器里的 MySQL/Redis，容易被整片 skip）。
 * 这里只盯一件事：**服务端会执行、但检查看不见**的写法。
 */
describe('SQL 守卫', () => {
  it('普通块注释会被剥掉，字符串与行注释里的分号不骗人', () => {
    expect(splitStatements("SELECT 'a;b' /* x;y */ FROM t; -- tail;")).toEqual(["SELECT 'a;b'   FROM t"]);
  });

  it('/*! ... */ 版本注释必须拒绝：切句器当注释丢了，mysqld 却当 SQL 执行', () => {
    for (const raw of [
      'SELECT 1 /*!SHUTDOWN*/',
      'SELECT 1 /*!GRANT ALL ON *.* TO hacker@localhost*/',
      'SELECT /*!LOAD_FILE("/etc/passwd")*/ 1',
      '/*!32000 DROP DATABASE arena*/ SELECT 1',
    ]) {
      const check = checkSubmissionSql(raw);
      expect(check.ok, raw).toBe(false);
      expect(check.reason, raw).toContain('版本注释');
    }
  });

  it('剥注释后看不见真语句的提交照样被拒（不能靠"看不见就算干净"放行）', () => {
    expect(checkSubmissionSql('/* SELECT 1 */ SHUTDOWN').ok).toBe(false);
    expect(checkSubmissionSql('-- 只是注释').ok).toBe(false);
  });

  it('普通块注释里的危险词不误伤（服务端不会执行它）', () => {
    expect(checkSubmissionSql('SELECT 1 /* 这里不需要 INTO OUTFILE */').ok).toBe(true);
  });
});

describe('Redis 守卫', () => {
  it('清库/配置/脚本/跨库类命令一律拒绝', () => {
    for (const line of ['FLUSHALL', 'FLUSHDB', 'KEYS *', 'EVAL "return 1" 0', 'CONFIG SET maxmemory 0', 'SHUTDOWN NOW', 'SELECT 3', 'SCRIPT LOAD x']) {
      expect(checkRedisCommand(tokenizeRedis(line)).ok, line).toBe(false);
    }
  });

  it('大小写与多余空白不影响判断，正常读写放行', () => {
    expect(checkRedisCommand(tokenizeRedis('  hset  k  f  v  ')).ok).toBe(true);
    expect(checkRedisCommand(tokenizeRedis('GET k')).ok).toBe(true);
  });
});
