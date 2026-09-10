# Static arity audit for a Workato SDK connector file.
# 1. Every `call(:name, args...)` — args count vs the lambda's parameter count in `methods:`.
# 2. Every hook lambda — parameter count vs the SDK's maximum for that hook.
require 'prism'

src = File.read(ARGV[0], encoding: 'UTF-8')
ast = Prism.parse(src).value

HOOK_MAX = {
  'apply' => 3, 'base_uri' => 1, 'acquire' => 3, 'refresh' => 2, 'detect_on' => 0,
  'test' => 1,
  'fields' => 3,                                    # object_definitions
  'input_fields' => 3, 'output_fields' => 3,
  'execute' => 5, 'sample_output' => 2,
  'poll' => 5, 'dedup' => 1, 'webhook_notification' => 8, 'webhook_subscribe' => 4, 'webhook_unsubscribe' => 2,
  'summarize_input' => 1, 'summarize_output' => 1
}

method_arity = {}
problems = []
hooks = []

def lambda_params(node)
  # node is a CallNode `lambda` with a block
  blk = node.block
  return nil unless blk && blk.parameters
  p = blk.parameters.parameters
  return 0 unless p
  req = p.requireds.length
  opt = p.optionals.length
  kw  = p.keywords.length
  rest = p.rest ? 1 : 0
  { req: req, opt: opt, kw: kw, rest: rest }
end

walk = lambda do |node, path|
  return unless node.is_a?(Prism::Node)
  case node
  when Prism::AssocNode
    key = node.key
    if key.is_a?(Prism::SymbolNode)
      kname = key.unescaped
      val = node.value
      if val.is_a?(Prism::CallNode) && val.name == :lambda
        params = lambda_params(val)
        if path.last == 'methods'
          method_arity[kname] = params
        elsif HOOK_MAX.key?(kname)
          hooks << [path + [kname], params]
        end
      end
      node.value && walk.call(node.value, path + [kname])
      return
    end
  when Prism::CallNode
    if node.name == :call && node.receiver.nil? && node.arguments
      args = node.arguments.arguments
      if args.first.is_a?(Prism::SymbolNode)
        name = args.first.unescaped
        problems << [:call, name, args.length - 1, node.location.start_line, path.last]
      end
    end
  end
  node.compact_child_nodes.each { |c| walk.call(c, path) }
end
walk.call(ast, [])

puts "== methods (#{method_arity.size}) =="
method_arity.each { |k, v| puts "  #{k}: #{v.inspect}" }

puts "\n== call sites vs method arity =="
bad = 0
problems.each do |_t, name, n, line, ctx|
  a = method_arity[name]
  if a.nil?
    puts "  line #{line}: call(:#{name}) — METHOD NOT DEFINED"; bad += 1; next
  end
  ok = a == 0 ? n == 0 : (n >= a[:req] && (a[:rest] == 1 || n <= a[:req] + a[:opt]))
  unless ok
    puts "  line #{line} (#{ctx}): call(:#{name}) with #{n} args, lambda takes #{a.inspect}"; bad += 1
  end
end
puts "  all #{problems.length} call sites match" if bad.zero?

puts "\n== hook lambdas over SDK maximum =="
over = 0
hooks.each do |path, params|
  n = params == 0 ? 0 : params[:req] + params[:opt]
  if n > HOOK_MAX[path.last]
    puts "  #{path.join('.')}: #{n} params (max #{HOOK_MAX[path.last]})"; over += 1
  end
end
puts "  none" if over.zero?
