# frozen_string_literal: true

# Runs the connector's actions on the shared fixtures with a minimal stand-in for the Workato SDK runtime.
# Only the calls the connector makes are shimmed: call(:method, ...), error(msg), and String#to_time.
#
# Usage: ruby run_ruby.rb <connector.rb> <fixtures.json> <ruby_out.json>
require 'json'
require 'time'
require 'securerandom'

class String
  # The SDK's String#to_time (ActiveSupport): naive strings are read as UTC-offset +00:00 on a UTC host.
  def to_time(*_args)
    Time.parse(self)
  end
end

class SdkRuntime
  def initialize(connector)
    @connector = connector
  end

  def call(name, *args)
    m = @connector[:methods][name.to_sym] || @connector[:methods][name.to_s]
    raise "unknown method #{name}" unless m
    instance_exec(*args, &m)
  end

  def error(message)
    raise StandardError, message
  end

  def run_action(name, input)
    action = @connector[:actions][name.to_sym]
    raise "unknown action #{name}" unless action
    instance_exec({}, input, &action[:execute])
  end

  def output_field_names(name)
    action = @connector[:actions][name.to_sym]
    defs = Hash.new { |h, k| h[k] = @connector[:object_definitions][k.to_sym][:fields].call({}, {}, h) }
    instance_exec(defs, &action[:output_fields])
  end
end

connector_path, fixtures_path, out_path = ARGV
connector = eval(File.read(connector_path), binding, connector_path) # rubocop:disable Security/Eval
rt = SdkRuntime.new(connector)
fixtures = JSON.parse(File.read(fixtures_path))

out = {}
fixtures.each do |action, cases|
  out[action] = cases.map do |c|
    begin
      { 'name' => c['name'], 'output' => rt.run_action(action, c['input']) }
    rescue StandardError => e
      { 'name' => c['name'], 'raises' => "#{e.class}: #{e.message}" }
    end
  end
end
File.write(out_path, JSON.pretty_generate(out))

# Also prove every action's output_fields definition resolves (object definitions reference each other).
fixtures.keys.each { |a| rt.output_field_names(a) }
puts "ruby outputs written: #{out.values.map(&:length).sum} cases; output_fields resolve for #{fixtures.keys.length} actions"
