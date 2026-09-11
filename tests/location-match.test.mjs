import assert from 'node:assert/strict';
import { pickConfidenceCandidate } from '../src/location-match.js';

const workplace = { address: '서울 강남구 영동대로 643' };

{
  const destination = { searchQuery: '서울지방노동위원회', originalName: '서울지방노동위원회' };
  const candidates = [
    { name: '서울지방노동위원회 본관', address: '서울 영등포구 문래로20길 56', lat: 37.5201, lon: 126.8951 },
  ];
  assert.equal(pickConfidenceCandidate(destination, candidates, workplace)?.name, '서울지방노동위원회 본관');
}

{
  const destination = { searchQuery: '고우넷 트레이닝센터', originalName: '고우넷 트레이닝센터' };
  const candidates = [
    { name: '고우넷트레이닝센터', address: '서울 성동구 아차산로5길 10-0', lat: 37.55, lon: 127.05 },
    { name: '고우넷트레이닝센터 주차장', address: '서울 성동구 아차산로5길 10-0', lat: 37.5501, lon: 127.0501 },
  ];
  assert.equal(pickConfidenceCandidate(destination, candidates, workplace)?.name, '고우넷트레이닝센터');
}

{
  const destination = { searchQuery: '서울특별시교육청융합과학교육원', originalName: '서울특별시교육청융합과학교육원' };
  const candidates = [
    { name: '서울특별시교육청융합과학교육원 남산본원', address: '서울 중구 소파로 46', lat: 37.553, lon: 126.981 },
    { name: '서울특별시교육청융합과학교육원 남산본원 주차장', address: '서울 중구 소파로 46', lat: 37.5531, lon: 126.9811 },
    { name: '서울특별시교육청융합과학교육원 동부분원', address: '서울 중랑구 면목로23길 20', lat: 37.57, lon: 127.08 },
    { name: '서울특별시교육청융합과학교육원 동부분원 주차장', address: '서울 중랑구 면목로23길 20', lat: 37.5701, lon: 127.0801 },
    { name: '서울특별시교육청융합과학교육원 본원', address: '서울 중구 소파로 46', lat: 37.55305, lon: 126.98105 },
  ];
  assert.equal(pickConfidenceCandidate(destination, candidates, workplace)?.name, '서울특별시교육청융합과학교육원 본원');
}

{
  const destination = { searchQuery: '가상교육원', originalName: '가상교육원' };
  const candidates = [
    { name: '가상교육원 강남본원', address: '서울 강남구 테헤란로 1', lat: 37.50, lon: 127.03 },
    { name: '가상교육원 종로본원', address: '서울 종로구 종로 1', lat: 37.57, lon: 126.98 },
  ];
  assert.equal(pickConfidenceCandidate(destination, candidates, workplace), null, '서로 다른 본원 후보가 두 곳이면 자동 선택하면 안 됩니다.');
}

console.log('Location match test passed');
