;; Float64 arithmetic and explicit Float32 stores preserve the JS renderer's
;; rounding. No relaxed SIMD, fast-math, voice culling or envelope shortcuts.
(module
  (memory (export "memory") 1)

  ;; Fixed scratch layout (bytes): voice 0, L/R 512/1024, effects sends
  ;; 1536/2048/2560, insertion L/R 3072/3584, filter coefficients/state 4096.
  (func $render (export "render") (param $n i32) (param $filter i32)
    (param $gain f64) (param $inc f64) (param $left f64) (param $right f64)
    (param $reverb f64) (param $chorus f64) (param $delay f64) (param $insert i32)
    (local $i i32) (local $l i32) (local $r i32) (local $p i32) (local $s f64) (local $input f64)
    (local $a0 f64) (local $a1 f64) (local $a2 f64) (local $a3 f64) (local $a4 f64)
    (local $x1 f64) (local $x2 f64) (local $y1 f64) (local $y2 f64)
    (local.set $a0 (f64.load (i32.const 4096)))
    (local.set $a1 (f64.load (i32.const 4104)))
    (local.set $a2 (f64.load (i32.const 4112)))
    (local.set $a3 (f64.load (i32.const 4120)))
    (local.set $a4 (f64.load (i32.const 4128)))
    (local.set $x1 (f64.load (i32.const 4136)))
    (local.set $x2 (f64.load (i32.const 4144)))
    (local.set $y1 (f64.load (i32.const 4152)))
    (local.set $y2 (f64.load (i32.const 4160)))
    (local.set $l (select (i32.const 3072) (i32.const 512) (local.get $insert)))
    (local.set $r (select (i32.const 3584) (i32.const 1024) (local.get $insert)))
    (block $end (loop $samples
      (br_if $end (i32.ge_u (local.get $i) (i32.shl (local.get $n) (i32.const 2))))
      (local.set $input (f64.promote_f32 (f32.load (local.get $i))))
      (local.set $s (local.get $input))
      (if (local.get $filter) (then
        (local.set $s (f64.sub (f64.sub (f64.add (f64.add
          (f64.mul (local.get $a0) (local.get $input))
          (f64.mul (local.get $a1) (local.get $x1)))
          (f64.mul (local.get $a2) (local.get $x2)))
          (f64.mul (local.get $a3) (local.get $y1)))
          (f64.mul (local.get $y2) (local.get $a4))))
        (local.set $x2 (local.get $x1)) (local.set $x1 (local.get $input))
        (local.set $y2 (local.get $y1)) (local.set $y1 (local.get $s))))
      (local.set $s (f64.promote_f32 (f32.demote_f64 (f64.mul (local.get $s) (local.get $gain)))))
      (f32.store (local.get $i) (f32.demote_f64 (local.get $s)))
      (local.set $gain (f64.add (local.get $gain) (local.get $inc)))
      ;; BEGIN_SCALAR_MIX
      (local.set $p (i32.add (local.get $l) (local.get $i)))
      (f32.store (local.get $p) (f32.demote_f64 (f64.add (f64.promote_f32 (f32.load (local.get $p))) (f64.mul (local.get $left) (local.get $s)))))
      (local.set $p (i32.add (local.get $r) (local.get $i)))
      (f32.store (local.get $p) (f32.demote_f64 (f64.add (f64.promote_f32 (f32.load (local.get $p))) (f64.mul (local.get $right) (local.get $s)))))
      (if (i32.eqz (local.get $insert)) (then
        (if (f64.gt (local.get $reverb) (f64.const 0)) (then
          (local.set $p (i32.add (i32.const 1536) (local.get $i)))
          (f32.store (local.get $p) (f32.demote_f64 (f64.add (f64.promote_f32 (f32.load (local.get $p))) (f64.mul (local.get $reverb) (local.get $s)))))))
        (if (f64.gt (local.get $chorus) (f64.const 0)) (then
          (local.set $p (i32.add (i32.const 2048) (local.get $i)))
          (f32.store (local.get $p) (f32.demote_f64 (f64.add (f64.promote_f32 (f32.load (local.get $p))) (f64.mul (local.get $chorus) (local.get $s)))))))
        (if (f64.gt (local.get $delay) (f64.const 0)) (then
          (local.set $p (i32.add (i32.const 2560) (local.get $i)))
          (f32.store (local.get $p) (f32.demote_f64 (f64.add (f64.promote_f32 (f32.load (local.get $p))) (f64.mul (local.get $delay) (local.get $s)))))))))
      ;; END_SCALAR_MIX
      (local.set $i (i32.add (local.get $i) (i32.const 4)))
      (br $samples)))
    ;; SIMD_MIX_CALL
    (if (local.get $filter) (then
      (f64.store (i32.const 4136) (local.get $x1)) (f64.store (i32.const 4144) (local.get $x2))
      (f64.store (i32.const 4152) (local.get $y1)) (f64.store (i32.const 4160) (local.get $y2)))))

  ;; Sample data follows the fixed scratch area. The adapter refreshes views
  ;; when the cache grows; no voice-count bound is encoded in this module.
  (func $hermite (export "hermite") (param $base i32) (param $loop i32)
    (param $loopEnd i32) (param $loopLength i32) (param $end i32)
    (param $cursor f64) (param $step f64) (param $n i32) (result i32)
    (local $i i32) (local $y0 i32) (local $y1 i32) (local $y2 i32) (local $y3 i32)
    (local $t f64) (local $xm1 f64) (local $x0 f64) (local $x1 f64) (local $x2 f64)
    (local $c f64) (local $v f64) (local $w f64) (local $a f64) (local $b f64)
    (block $done (loop $samples
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (if (local.get $loop) (then
        (block $wrapped (loop $wrap
          (br_if $wrapped (f64.lt (local.get $cursor) (f64.convert_i32_s (local.get $loopEnd))))
          (local.set $cursor (f64.sub (local.get $cursor) (f64.convert_i32_s (local.get $loopLength))))
          (br $wrap)))))
      (local.set $y0 (i32.trunc_f64_s (local.get $cursor)))
      (local.set $y1 (i32.add (local.get $y0) (i32.const 1)))
      (local.set $y2 (i32.add (local.get $y0) (i32.const 2)))
      (local.set $y3 (i32.add (local.get $y0) (i32.const 3)))
      (local.set $t (f64.sub (local.get $cursor) (f64.convert_i32_s (local.get $y0))))
      (if (local.get $loop) (then
        (block $w1 (loop $l1 (br_if $w1 (i32.lt_s (local.get $y1) (local.get $loopEnd)))
          (local.set $y1 (i32.sub (local.get $y1) (local.get $loopLength))) (br $l1)))
        (block $w2 (loop $l2 (br_if $w2 (i32.lt_s (local.get $y2) (local.get $loopEnd)))
          (local.set $y2 (i32.sub (local.get $y2) (local.get $loopLength))) (br $l2)))
        (block $w3 (loop $l3 (br_if $w3 (i32.lt_s (local.get $y3) (local.get $loopEnd)))
          (local.set $y3 (i32.sub (local.get $y3) (local.get $loopLength))) (br $l3))))
      (else (if (i32.ge_s (local.get $y3) (local.get $end)) (then
        (memory.fill (i32.shl (local.get $i) (i32.const 2)) (i32.const 0)
          (i32.shl (i32.sub (local.get $n) (local.get $i)) (i32.const 2)))
        (return (i32.const 0))))))
      (local.set $xm1 (f64.promote_f32 (f32.load (i32.add (local.get $base) (i32.shl (local.get $y0) (i32.const 2))))))
      (local.set $x0 (f64.promote_f32 (f32.load (i32.add (local.get $base) (i32.shl (local.get $y1) (i32.const 2))))))
      (local.set $x1 (f64.promote_f32 (f32.load (i32.add (local.get $base) (i32.shl (local.get $y2) (i32.const 2))))))
      (local.set $x2 (f64.promote_f32 (f32.load (i32.add (local.get $base) (i32.shl (local.get $y3) (i32.const 2))))))
      (local.set $c (f64.mul (f64.sub (local.get $x1) (local.get $xm1)) (f64.const 0.5)))
      (local.set $v (f64.sub (local.get $x0) (local.get $x1)))
      (local.set $w (f64.add (local.get $c) (local.get $v)))
      (local.set $a (f64.add (f64.add (local.get $w) (local.get $v))
        (f64.mul (f64.sub (local.get $x2) (local.get $x0)) (f64.const 0.5))))
      (local.set $b (f64.add (local.get $w) (local.get $a)))
      (f32.store (i32.shl (local.get $i) (i32.const 2)) (f32.demote_f64
        (f64.add (f64.mul (f64.add (f64.mul (f64.sub
          (f64.mul (local.get $a) (local.get $t)) (local.get $b)) (local.get $t))
          (local.get $c)) (local.get $t)) (local.get $x0))))
      (local.set $cursor (f64.add (local.get $cursor) (local.get $step)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $samples)))
    (f64.store (i32.const 4200) (local.get $cursor)) (i32.const 1))
  ;; SIMD_MIX_FUNCTION
  (func (export "processVoice") (param $n i32) (param $filter i32)
    (param $gain f64) (param $inc f64) (param $left f64) (param $right f64)
    (param $reverb f64) (param $chorus f64) (param $delay f64) (param $insert i32)
    (param $base i32) (param $loop i32) (param $loopEnd i32) (param $loopLength i32)
    (param $end i32) (param $cursor f64) (param $step f64) (result i32)
    (local $active i32)
    (local.set $active (i32.const 1))
    (if (local.get $base) (then
      (local.set $active (call $hermite (local.get $base) (local.get $loop)
        (local.get $loopEnd) (local.get $loopLength) (local.get $end)
        (local.get $cursor) (local.get $step) (local.get $n)))))
    (call $render (local.get $n) (local.get $filter) (local.get $gain) (local.get $inc)
      (local.get $left) (local.get $right) (local.get $reverb) (local.get $chorus)
      (local.get $delay) (local.get $insert))
    (local.get $active))
)
