from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app
from lingxi.workspace.service import WorkspaceError, WorkspaceService


def test_interview_append_retry_unknown_and_original_files(tmp_path):
    with TestClient(create_app()) as client:
        client.post('/api/workspaces/open', json={'path': str(tmp_path)})
        person = client.post('/api/people', json={'display_name': '小林（虚构）', 'relation_to_user': '朋友'}).json()
        original = (tmp_path / 'people' / f"{person['id']}.md").read_bytes()
        payload = {'request_id': str(uuid4()), 'answers': [
            {'question': '喜欢读什么书？', 'answer': '喜欢天文学🍵', 'status': 'answered'},
            {'question': '重要经历？', 'answer': '不确定', 'status': 'unknown'},
        ], 'attachments': [{'name': '原始记录.md', 'text': '# 原话\n\n喜欢看星星。\n'}]}
        first = client.post(f"/api/people/{person['id']}/interview", json=payload)
        assert first.status_code == 201, first.text
        sources = first.json()['sources']
        assert len(sources) == 2
        body = (tmp_path / sources[0]['original_path']).read_text()
        assert '喜欢天文学🍵' in body and '还不知道' in body
        assert (tmp_path / sources[1]['original_path']).read_text() == payload['attachments'][0]['text']
        assert (tmp_path / 'people' / f"{person['id']}.md").read_bytes() == original
        assert client.post(f"/api/people/{person['id']}/interview", json=payload).json()['replayed'] is True
        assert len(client.get('/api/sources').json()['items']) == 2
        payload['answers'][0]['answer'] = '不同资料'
        assert client.post(f"/api/people/{person['id']}/interview", json=payload).status_code == 409
        assert client.post(f"/api/people/{person['id']}/interview", json={'request_id': str(uuid4())}).status_code == 422


def test_failed_interview_preserves_existing_person_and_retry(tmp_path, monkeypatch):
    import lingxi.workspace.service as service
    workspace = WorkspaceService(); workspace.open(tmp_path)
    person = workspace.create_person('已有人物', '朋友')
    before = (tmp_path / 'people' / f"{person['id']}.md").read_bytes()
    args = (person['id'], [{'question': '爱好？', 'answer': '茶', 'status': 'answered'}], [], str(uuid4()))
    original = service._atomic_create
    def fail(path, data):
        if path.parent.name == 'sources': raise OSError('simulated source failure')
        return original(path, data)
    monkeypatch.setattr(service, '_atomic_create', fail)
    with pytest.raises(OSError): workspace.append_person_interview(*args)
    assert workspace.list_entities('source') == []
    assert (tmp_path / 'people' / f"{person['id']}.md").read_bytes() == before
    assert list((tmp_path / '归档').rglob('original.txt'))
    monkeypatch.setattr(service, '_atomic_create', original)
    assert len(workspace.append_person_interview(*args)['sources']) == 1


def test_interview_refuses_symlink_attachment_directory(tmp_path):
    (tmp_path / 'vault').mkdir()
    workspace = WorkspaceService(); workspace.open(tmp_path / 'vault')
    person = workspace.create_person('测试人物', '朋友')
    request_id = uuid4()
    from uuid import uuid5
    sid = str(uuid5(request_id, 'lingxi:interview:0'))
    external = tmp_path / 'external'; external.mkdir()
    (tmp_path / 'vault' / 'attachments' / sid).symlink_to(external, target_is_directory=True)
    with pytest.raises(WorkspaceError):
        workspace.append_person_interview(person['id'], [{'question':'爱好？','answer':'茶','status':'answered'}], [], str(request_id))
    assert list(external.iterdir()) == []
