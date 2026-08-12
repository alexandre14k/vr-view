import http.server as root_http_server
import sys as root_sys

class Handler(root_http_server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.route_request()

    def route_request(self):
        if self.path == '/':
            self.serve_file('index.html', 'text/html')
        elif self.path == '/src/index.js':
            self.serve_file(
                'src/index.js', 'application/javascript')
        elif self.path == '/src/style.css':
            self.serve_file('src/style.css', 'text/css')
        else:
            self.send_error(404)

    def serve_file(self, filename, content_type):
        try:
            with open(filename, 'rb') as f:
                self.send_response(200)
                self.send_header(
                    'Content-type', content_type)
                self.end_headers()
                self.wfile.write(f.read())
        except FileNotFoundError:
            self.send_error(404)

def execute_server():
    host = '0.0.0.0'
    port = 8080
    httpd = root_http_server.HTTPServer(
        (host, port), Handler)
    root_sys.stdout.write(
        f"Listen socket: http://{host}:{port}\n")
    root_sys.stdout.flush()
    httpd.serve_forever()

if __name__ == '__main__':
    execute_server()