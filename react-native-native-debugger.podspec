require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'react-native-native-debugger'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = "https://www.npmjs.com/package/#{package['name']}"
  s.license      = { :type => 'MIT', :file => 'LICENSE' }
  s.author       = { 'react-native-native-debugger' => s.homepage }
  s.platforms    = { :ios => '13.0' }
  s.source       = { :http => "https://registry.npmjs.org/#{package['name']}/-/#{package['name']}-#{s.version}.tgz" }
  s.source_files = 'ios/**/*.{h,m,mm}'
  s.requires_arc = true
  s.dependency 'React-Core'
end
